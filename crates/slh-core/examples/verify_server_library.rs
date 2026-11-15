//! Opt-in catalog verification. Server directories are read, never started or rewritten.
use slh_core::{database,local_servers::library,portable::PortablePaths,state::AppState};
use std::path::{Path,PathBuf};
#[tokio::main(flavor="multi_thread",worker_threads=2)]
async fn main()->Result<(),Box<dyn std::error::Error>>{
 let args:Vec<_>=std::env::args().collect();let temp=std::fs::canonicalize(args.get(1).ok_or("Marked test root required")?)?;
 if !temp.join(".server-test-root").is_file(){return Err("Test marker required".into());}
 let directory=args.get(2).ok_or("Server directory required")?.clone();
 let paths=PortablePaths::from_executable(&temp.join("probe.exe"),Some(temp.clone()))?;
 let mut state=AppState::initialize_isolated_at(paths).await?;
 if let Some(target)=args.get(3){
  let target=std::fs::canonicalize(target)?;
  if target!=std::fs::canonicalize("E:/SLH")?||!target.join("portable.flag").is_file(){return Err("Only the explicitly requested installed portable launcher is allowed".into());}
  let backup=std::fs::canonicalize(PathBuf::from(args.get(4).ok_or("Existing pre-update database backup required")?))?;
  if !backup.starts_with(target.join("launcher-backups"))||!backup.join("database/app.db").is_file(){return Err("Verified database backup required".into());}
  state.database.close().await;
  state.paths=PortablePaths::from_executable(&target.join("SLH.exe"),Some(target.clone()))?;
  state.database=database::connect(&state.paths).await?;
 }
 let first=library::synchronize(&state,Some(directory.clone())).await?;
 let ids:Vec<_>=first.servers.iter().map(|s|s.id.clone()).collect();let again=library::synchronize(&state,None).await?;
 assert_eq!(ids,again.servers.iter().map(|s|s.id.clone()).collect::<Vec<_>>());assert_eq!(again.directory,directory);
 let gdz=again.collections.iter().find(|g|g.name=="gdz"&&g.source_path.as_deref().is_some_and(|p|p.replace(char::from(92),"/").ends_with("/servers/gdz"))).ok_or("Missing gdz collection")?;
 assert!(again.servers.iter().filter(|s|s.presentation["collectionId"]==gdz.id).count()>=7);
 let summary=serde_json::json!({"directory":again.directory,"profiles":again.servers.len(),"ready":again.servers.iter().filter(|s|s.presentation["readiness"]=="ready").count(),"needsSetup":again.servers.iter().filter(|s|s.presentation["readiness"]=="needs_setup").count(),"groups":again.collections,"persistentIds":ids,"rootPersisted":true});
 std::fs::write(temp.join("library-result.json"),serde_json::to_vec_pretty(&summary)?)?;
 println!("{}",serde_json::to_string_pretty(&summary)?);
 state.database.close().await;
 assert!(Path::new(&directory).is_dir());Ok(())
}
