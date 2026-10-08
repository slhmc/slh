pub mod curseforge;
pub mod install;
pub mod modrinth;

use async_trait::async_trait;

use crate::error::AppResult;
use crate::models::{ModrinthSearchResult, ProviderAvailability};
use crate::state::AppState;

#[async_trait]
pub trait ContentProvider: Send + Sync {
    fn provider_type(&self) -> &'static str;
    async fn search(
        &self,
        state: &AppState,
        query: &str,
        project_type: Option<&str>,
        game_version: Option<&str>,
        loader: Option<&str>,
        sort: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> AppResult<ModrinthSearchResult>;
}

pub struct ModrinthProvider;
pub struct CurseForgeProvider;

#[async_trait]
impl ContentProvider for ModrinthProvider {
    fn provider_type(&self) -> &'static str {
        "modrinth"
    }

    async fn search(
        &self,
        state: &AppState,
        query: &str,
        project_type: Option<&str>,
        game_version: Option<&str>,
        loader: Option<&str>,
        sort: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> AppResult<ModrinthSearchResult> {
        modrinth::search(
            state,
            query,
            project_type,
            game_version,
            loader,
            sort,
            offset,
            limit,
        )
        .await
    }
}

#[async_trait]
impl ContentProvider for CurseForgeProvider {
    fn provider_type(&self) -> &'static str {
        "curseforge"
    }

    async fn search(
        &self,
        state: &AppState,
        query: &str,
        project_type: Option<&str>,
        game_version: Option<&str>,
        loader: Option<&str>,
        sort: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> AppResult<ModrinthSearchResult> {
        curseforge::search(
            state,
            query,
            project_type,
            game_version,
            loader,
            sort,
            offset,
            limit,
        )
        .await
    }
}

pub async fn search(
    state: &AppState,
    provider: &str,
    query: &str,
    project_type: Option<&str>,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    offset: u64,
    limit: u64,
) -> AppResult<ModrinthSearchResult> {
    let provider: &dyn ContentProvider = match provider {
        "modrinth" => &ModrinthProvider,
        "curseforge" => &CurseForgeProvider,
        _ => {
            return Err(crate::error::AppError::Unavailable(format!(
                "Content provider {provider} is unavailable"
            )));
        }
    };
    let _provider_type = provider.provider_type();
    provider
        .search(
            state,
            query,
            project_type,
            game_version,
            loader,
            sort,
            offset,
            limit,
        )
        .await
}

pub async fn curseforge_availability(state: &AppState) -> (bool, &'static str) {
    match state.curseforge_api_key.read().await.as_ref() {
        Some(_) => (
            true,
            "Personal API key configured; CurseForge requests use the direct official API.",
        ),
        _ => (
            true,
            "SLH relay configured; no personal API key is required. The first request verifies relay availability.",
        ),
    }
}

pub async fn provider_availability(state: &AppState) -> Vec<ProviderAvailability> {
    let (curseforge, message) = curseforge_availability(state).await;
    vec![
        ProviderAvailability {
            provider: "modrinth".into(),
            available: true,
            message: Some("Public API available; compatible installs use verified hashes.".into()),
        },
        ProviderAvailability {
            provider: "curseforge".into(),
            available: curseforge,
            message: Some(message.into()),
        },
    ]
}
