//! A UI-independent owner for a Java server. Closing either UI does not close Java's stdin.
use super::{
    config::LaunchPlan,
    store::{atomic_write, plain_path},
};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{RwLock, mpsc, oneshot},
};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub server_id: String,
    pub host_pid: u32,
    pub java_pid: u32,
    pub java_started: u64,
    pub endpoint: String,
    pub token: String,
    pub state: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerLine {
    pub seq: u64,
    pub text: String,
    pub stream: String,
    pub timestamp: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPlan {
    pub server_id: String,
    pub launch: LaunchPlan,
    pub run_file: PathBuf,
    pub log_file: PathBuf,
}
#[derive(Serialize, Deserialize)]
pub struct Request {
    pub token: String,
    pub action: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub cursor: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    #[serde(default)]
    pub run_id: Option<String>,
    pub state: String,
    pub lines: Vec<ServerLine>,
    pub last_seq: u64,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}
struct Control {
    request: Request,
    result: oneshot::Sender<HostSnapshot>,
}
struct Shared {
    info: RunInfo,
    lines: VecDeque<ServerLine>,
    seq: u64,
}

pub fn process_identity(pid: u32) -> Option<u64> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let id = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[id]),
        false,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    system.process(id).map(|p| p.start_time())
}
pub fn read_run(path: &Path) -> AppResult<RunInfo> {
    plain_path(path)?;
    let meta = std::fs::metadata(path)?;
    if meta.len() > 64 * 1024 {
        return Err(AppError::Security("Invalid server run descriptor".into()));
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn save_run(path: &Path, info: &RunInfo) -> AppResult<()> {
    atomic_write(path, &serde_json::to_vec(info)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
pub async fn request(
    info: &RunInfo,
    action: &str,
    command: &str,
    cursor: u64,
) -> AppResult<HostSnapshot> {
    let address: std::net::SocketAddr = info
        .endpoint
        .parse()
        .map_err(|_| AppError::Security("Invalid server control address".into()))?;
    if !address.ip().is_loopback() {
        return Err(AppError::Security(
            "Server control must be loopback-only".into(),
        ));
    }
    let operation = async {
        let mut stream = TcpStream::connect(address).await?;
        let mut payload = serde_json::to_vec(&Request {
            token: info.token.clone(),
            action: action.into(),
            command: command.into(),
            cursor,
        })?;
        payload.push(b'\n');
        stream.write_all(&payload).await?;
        let bytes = read_line_limited(&mut BufReader::new(stream), 1024 * 1024)
            .await?
            .ok_or_else(|| AppError::Process("Server host closed the connection".into()))?;
        let mut snapshot: HostSnapshot = serde_json::from_slice(&bytes)?;
        // Identify older packaged hosts too, without exposing the control token.
        snapshot.run_id = Some(console_run_id(info));
        Ok::<_, AppError>(snapshot)
    };
    tokio::time::timeout(std::time::Duration::from_secs(4), operation)
        .await
        .map_err(|_| AppError::Process("Server control timed out".into()))?
}
async fn read_line_limited<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> AppResult<Option<Vec<u8>>> {
    let mut out = Vec::new();
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            return Ok(if out.is_empty() { None } else { Some(out) });
        }
        let end = bytes.iter().position(|v| *v == b'\n');
        let len = end.map_or(bytes.len(), |i| i + 1);
        if out.len() + len > max {
            return Err(AppError::Security("Console line exceeds size limit".into()));
        }
        out.extend_from_slice(&bytes[..len]);
        reader.consume(len);
        if end.is_some() {
            return Ok(Some(out));
        }
    }
}
async fn read_console_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> AppResult<Option<Vec<u8>>> {
    let mut out = Vec::new();
    let mut seen = false;
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            return Ok(if seen { Some(out) } else { None });
        }
        seen = true;
        let end = bytes.iter().position(|b| *b == b'\n');
        let len = end.map_or(bytes.len(), |n| n + 1);
        out.extend_from_slice(&bytes[..len.min(max.saturating_sub(out.len()))]);
        reader.consume(len);
        if end.is_some() {
            return Ok(Some(out));
        }
    }
}
async fn forward<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    source: R,
    stream: &'static str,
    sender: mpsc::Sender<(String, String)>,
) {
    let mut input = BufReader::new(source);
    loop {
        match read_console_line(&mut input, 64 * 1024).await {
            Ok(Some(line)) => {
                if sender
                    .send((
                        String::from_utf8_lossy(&line)
                            .trim_end_matches(['\r', '\n'])
                            .to_owned(),
                        stream.into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            _ => break,
        }
    }
}
fn snapshot(shared: &Shared, cursor: u64) -> HostSnapshot {
    HostSnapshot {
        run_id: Some(console_run_id(&shared.info)),
        state: shared.info.state.clone(),
        lines: shared
            .lines
            .iter()
            .filter(|l| l.seq > cursor)
            .take(1000)
            .cloned()
            .collect(),
        last_seq: shared.seq,
        exit_code: shared.info.exit_code,
        error: shared.info.error.clone(),
    }
}
pub fn console_run_id(info: &RunInfo) -> String {
    format!("{}:{}:{}", info.host_pid, info.java_started, info.endpoint)
}
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

pub async fn run(plan: HostPlan) -> AppResult<()> {
    plain_path(Path::new(&plan.launch.directory))?;
    plain_path(&plan.run_file)?;
    plain_path(&plan.log_file)?;
    let mut log = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&plan.log_file)
        .await?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let mut command = tokio::process::Command::new(&plan.launch.java);
    command
        .args(&plan.launch.args)
        .current_dir(&plan.launch.directory)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| AppError::Process("Server has no process ID".into()))?;
    let mut stdin = child.stdin.take().unwrap();
    let (line_tx, mut line_rx) = mpsc::channel(512);
    tokio::spawn(forward(
        child.stdout.take().unwrap(),
        "stdout",
        line_tx.clone(),
    ));
    tokio::spawn(forward(child.stderr.take().unwrap(), "stderr", line_tx));
    let info = RunInfo {
        server_id: plan.server_id,
        host_pid: std::process::id(),
        java_pid: pid,
        java_started: process_identity(pid).unwrap_or(0),
        endpoint: listener.local_addr()?.to_string(),
        token: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
        state: "starting".into(),
        exit_code: None,
        error: None,
    };
    if let Err(error) = save_run(&plan.run_file, &info) {
        let _ = child.kill().await;
        return Err(error);
    }
    let shared = Arc::new(RwLock::new(Shared {
        info,
        lines: VecDeque::new(),
        seq: 0,
    }));
    let (control_tx, mut control_rx) = mpsc::channel::<Control>(64);
    let accept_shared = shared.clone();
    let accept = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let tx = control_tx.clone();
            let shared = accept_shared.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(socket);
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    read_line_limited(&mut reader, 16 * 1024),
                )
                .await;
                let Ok(Ok(Some(bytes))) = result else { return };
                let Ok(req) = serde_json::from_slice::<Request>(&bytes) else {
                    return;
                };
                if !same_token(&req.token, &shared.read().await.info.token) {
                    return;
                }
                let response = if req.action == "status" {
                    snapshot(&*shared.read().await, req.cursor)
                } else {
                    let (result, rx) = oneshot::channel();
                    if tx
                        .send(Control {
                            request: req,
                            result,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let Ok(value) = rx.await else { return };
                    value
                };
                if let Ok(mut bytes) = serde_json::to_vec(&response) {
                    bytes.push(b'\n');
                    let _ = reader.get_mut().write_all(&bytes).await;
                }
            });
        }
    });
    let exit = loop {
        tokio::select! {
            status=child.wait()=>break status,
            Some((text,stream))=line_rx.recv()=>{
                let mut state=shared.write().await;state.seq+=1;
                // A running Java process is distinct from a fully ready Minecraft server.
                if state.info.state=="starting" && (text.contains("Done (") || text.contains("For help, type")){state.info.state="running".into();let _=save_run(&plan.run_file,&state.info);}
                let line=ServerLine{seq:state.seq,text,stream,timestamp:chrono::Utc::now().to_rfc3339()};
                if let Ok(mut bytes)=serde_json::to_vec(&line){bytes.push(b'\n');let _=log.write_all(&bytes).await;}
                state.lines.push_back(line);while state.lines.len()>2000{state.lines.pop_front();}
                if log.metadata().await.is_ok_and(|m|m.len()>10*1024*1024){let _=log.flush().await;drop(log);let previous=plan.log_file.with_extension("previous.jsonl");let _=tokio::fs::remove_file(&previous).await;let _=tokio::fs::rename(&plan.log_file,&previous).await;log=tokio::fs::OpenOptions::new().create(true).append(true).open(&plan.log_file).await?;}
            },
            Some(control)=control_rx.recv()=>{
                let mut state=shared.write().await;
                match control.request.action.as_str(){
                    "stop"=>{let _=stdin.write_all(b"stop\n").await;let _=stdin.flush().await;state.info.state="stopping".into();},
                    "kill"=>{let _=child.start_kill();state.info.state="stopping".into();},
                    "command"=>{if control.request.command.len()<=4096 && !control.request.command.contains(['\0','\r','\n']){let _=stdin.write_all(format!("{}\n",control.request.command).as_bytes()).await;let _=stdin.flush().await;}},_=>{}
                }
                let _=save_run(&plan.run_file,&state.info);let _=control.result.send(snapshot(&state,control.request.cursor));
            }
        }
    };
    let mut state = shared.write().await;
    match exit {
        Ok(status) => {
            state.info.exit_code = status.code();
            let never_ready = state.info.state == "starting";
            if never_ready {
                state.info.error = Some("The Java process exited before the Minecraft server became ready; inspect its console log".into());
            }
            state.info.state = if status.success() && !never_ready {
                "stopped"
            } else {
                "failed"
            }
            .into();
        }
        Err(e) => {
            state.info.state = "failed".into();
            state.info.error = Some(e.to_string());
        }
    }
    log.flush().await?;
    save_run(&plan.run_file, &state.info)?;
    accept.abort();
    Ok(())
}

pub async fn console(path: &Path) -> AppResult<()> {
    let info = read_run(path)?;
    println!(
        "SLH server console: {}\nClosing this window leaves the server running.\n",
        info.server_id
    );
    let (tx, mut rx) = mpsc::channel::<String>(32);
    tokio::spawn(async move {
        let mut input = BufReader::new(tokio::io::stdin());
        while let Ok(Some(bytes)) = read_line_limited(&mut input, 8192).await {
            let line = String::from_utf8_lossy(&bytes).trim().to_owned();
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });
    let mut cursor = 0;
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
    loop {
        tokio::select! {_=tick.tick()=>{match request(&info,"status","",cursor).await{Ok(snapshot)=>{for line in snapshot.lines{cursor=line.seq;println!("{}",line.text);}if ["stopped","failed"].contains(&snapshot.state.as_str()){break;}},Err(_)=>break}},Some(line)=rx.recv()=>{if line=="/detach"{break;}request(&info,"command",&line,cursor).await?;}}
    }
    Ok(())
}
pub async fn entry() -> AppResult<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err(AppError::InvalidInput(
            "Expected run <plan.json> or console <run.json>".into(),
        ));
    }
    let path = PathBuf::from(&args[1]);
    plain_path(&path)?;
    match args[0].to_str() {
        Some("run") => {
            let bytes = tokio::fs::read(&path).await?;
            if bytes.len() > 1024 * 1024 {
                return Err(AppError::Security("Server plan too large".into()));
            }
            let plan: HostPlan = serde_json::from_slice(&bytes)?;
            run(plan).await
        }
        Some("console") => console(&path).await,
        _ => Err(AppError::InvalidInput("Unknown server-host mode".into())),
    }
}

pub fn saved_console(path: &Path, cursor: u64) -> Vec<ServerLine> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return vec![];
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let offset = size.saturating_sub(1024 * 1024);
    let _ = file.seek(SeekFrom::Start(offset));
    let mut text = String::new();
    let _ = file.take(1024 * 1024).read_to_string(&mut text);
    text.lines()
        .filter_map(|s| serde_json::from_str::<ServerLine>(s).ok())
        .filter(|line| line.seq > cursor)
        .take(1000)
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn legacy_hosts_get_a_stable_public_console_run_identity() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut info = RunInfo { server_id: "server".into(), host_pid: 123, java_pid: 456, java_started: 100,
            endpoint: listener.local_addr().unwrap().to_string(), token: "private-control-token".into(),
            state: "running".into(), exit_code: None, error: None };
        let reply = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            reader.get_mut().write_all(b"{\"state\":\"running\",\"lines\":[],\"lastSeq\":7,\"exitCode\":null,\"error\":null}\n").await.unwrap();
        });
        let result = request(&info, "status", "", 0).await.unwrap();
        reply.await.unwrap();
        assert_eq!(result.run_id, Some(console_run_id(&info)));
        assert!(!serde_json::to_string(&result).unwrap().contains(&info.token));
        let old_id = console_run_id(&info);
        info.java_started += 1;
        assert_ne!(old_id, console_run_id(&info));
    }
    #[test]
    fn control_token_comparison() {
        assert!(same_token("abc", "abc"));
        assert!(!same_token("abc", "abd"));
        assert!(!same_token("abc", "abcd"));
    }
}
