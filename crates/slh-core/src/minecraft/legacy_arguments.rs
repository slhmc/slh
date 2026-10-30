//! Legacy loader profiles contain their own Minecraft options. Keep the last
//! value of singleton options (the loader overrides vanilla), but preserve
//! repeatable mod options such as --tweakClass and unrelated positional args.
use std::collections::HashSet;
use crate::error::{AppError, AppResult};

fn singleton(option: &str) -> bool {
    matches!(option, "--username" | "--version" | "--gameDir" | "--assetsDir"
        | "--assetIndex" | "--uuid" | "--accessToken" | "--userType"
        | "--versionType" | "--userProperties" | "--profileProperties"
        | "--session" | "--gameAssets" | "--width" | "--height" | "--server" | "--port")
}

pub(crate) fn normalize(arguments: Vec<String>) -> AppResult<Vec<String>> {
    let mut entries = Vec::new();
    let mut arguments = arguments.into_iter().peekable();
    while let Some(argument) = arguments.next() {
        let option = argument.split_once('=').map_or(argument.as_str(), |(key, _)| key);
        if singleton(option) {
            let key = option.to_owned();
            let mut tokens = vec![argument];
            if !tokens[0].contains('=') {
                let value = arguments.next().filter(|value| !value.starts_with("--")).ok_or_else(|| {
                    AppError::InvalidInput(format!("Legacy Minecraft option {key} has no value"))
                })?;
                tokens.push(value);
            }
            entries.push((Some(key), tokens));
        } else {
            // A repeatable option's value is one token even if it looks like
            // another flag; never interpret it as a vanilla option to delete.
            let mut tokens = vec![argument];
            if tokens[0] == "--tweakClass" {
                if let Some(value) = arguments.next() { tokens.push(value); }
            }
            entries.push((None, tokens));
        }
    }
    let mut seen = HashSet::new();
    let mut retained = Vec::new();
    for (key, tokens) in entries.into_iter().rev() {
        if key.is_none_or(|key| seen.insert(key)) { retained.push(tokens); }
    }
    Ok(retained.into_iter().rev().flatten().collect())
}

pub(crate) fn parse(arguments: &str) -> AppResult<Vec<String>> {
    normalize(shlex::split(arguments).ok_or_else(|| {
        AppError::InvalidInput("Legacy Minecraft arguments contain invalid quoting".into())
    })?)
}

pub(crate) fn merge(base: Option<&str>, loader: &str) -> AppResult<String> {
    let arguments = match base { Some(base) => format!("{base} {loader}"), None => loader.to_owned() };
    Ok(shlex::try_join(parse(&arguments)?.iter().map(String::as_str))
        .map_err(|_| AppError::InvalidInput("Legacy Minecraft arguments contain a NUL byte".into()))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_overrides_vanilla_singletons_and_keeps_repeatable_tweakers() {
        let vanilla = "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --versionType release";
        let forge = "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge --tweakClass optifine.OptiFineForgeTweaker";
        let merged = merge(Some(vanilla), forge).unwrap();
        let arguments = parse(&merged).unwrap();
        for option in ["--username", "--version", "--gameDir", "--assetsDir", "--versionType"] {
            assert_eq!(arguments.iter().filter(|arg| *arg == option).count(), 1, "{option}");
        }
        assert!(arguments.windows(2).any(|pair| pair == ["--versionType", "Forge"]));
        assert_eq!(arguments.iter().filter(|arg| *arg == "--tweakClass").count(), 2);
        assert_eq!(normalize(arguments.clone()).unwrap(), arguments);
    }

    #[test]
    fn quoted_paths_equals_and_partial_loader_arguments_remain_valid() {
        let arguments = parse("--gameDir 'E:/Old Pack/game' --gameDir=E:/New --custom value --custom other --width 800 --width 1280").unwrap();
        assert!(!arguments.iter().any(|arg| arg == "E:/Old Pack/game"));
        assert!(arguments.contains(&"--gameDir=E:/New".to_owned()));
        assert_eq!(arguments.iter().filter(|arg| *arg == "--custom").count(), 2);
        let merged = merge(Some("--gameDir 'E:/A Pack/game' --username Player"), "--tweakClass example.Tweaker").unwrap();
        assert!(parse(&merged).unwrap().contains(&"E:/A Pack/game".to_owned()));
        assert!(parse("--gameDir --username Player").is_err());
        assert!(parse("--gameDir 'unterminated").is_err());
    }
}
