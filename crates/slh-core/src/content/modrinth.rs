use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::models::{
    ModpackVersionOption, ModrinthProject, ModrinthProjectDetails, ModrinthSearchResult,
    ProjectGalleryImage,
};
use crate::state::AppState;

const SEARCH_URL: &str = "https://api.modrinth.com/v2/search";

#[derive(Deserialize)]
struct ApiSearchResult {
    hits: Vec<ApiProject>,
    offset: u64,
    limit: u64,
    total_hits: u64,
}

#[derive(Deserialize)]
struct ApiProject {
    project_id: String,
    slug: String,
    title: String,
    description: String,
    project_type: String,
    icon_url: Option<String>,
    downloads: u64,
    follows: u64,
    author: String,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    versions: Vec<String>,
    date_modified: String,
}

#[derive(Deserialize)]
struct ApiProjectDetails {
    id: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    gallery: Vec<ApiGalleryImage>,
}

#[derive(Deserialize)]
struct ApiGalleryImage {
    url: String,
    raw_url: Option<String>,
    title: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct ApiModpackVersion {
    id: String,
    name: String,
    version_number: String,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
}

pub async fn project_details(
    state: &AppState,
    project_id: &str,
) -> AppResult<ModrinthProjectDetails> {
    if project_id.is_empty()
        || project_id.len() > 128
        || !project_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err(AppError::InvalidInput("Invalid Modrinth project ID".into()));
    }
    let details: ApiProjectDetails = state
        .http
        .get(format!("https://api.modrinth.com/v2/project/{project_id}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let modpack_versions: Vec<ApiModpackVersion> = state
        .http
        .get(format!(
            "https://api.modrinth.com/v2/project/{project_id}/version"
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(ModrinthProjectDetails {
        project_id: details.id,
        body: details.body,
        gallery: details
            .gallery
            .into_iter()
            .filter_map(|image| {
                let thumbnail_url = approved_media_url(image.url)?;
                let url = image
                    .raw_url
                    .and_then(approved_media_url)
                    .unwrap_or_else(|| thumbnail_url.clone());
                Some(ProjectGalleryImage {
                    url,
                    thumbnail_url: Some(thumbnail_url),
                    title: image.title,
                    description: image.description,
                })
            })
            .take(12)
            .collect(),
        modpack_versions: modpack_versions
            .into_iter()
            .map(|version| ModpackVersionOption {
                id: version.id,
                name: version.name,
                version_number: version.version_number,
                game_versions: version.game_versions,
                loaders: version.loaders,
            })
            .collect(),
    })
}

pub async fn search(
    state: &AppState,
    query: &str,
    project_type: Option<&str>,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    offset: u64,
    limit: u64,
) -> AppResult<ModrinthSearchResult> {
    let limit = limit.clamp(1, 40);
    let project_type = project_type.unwrap_or("modpack");
    if !["modpack", "mod", "resourcepack", "shader"].contains(&project_type) {
        return Err(AppError::InvalidInput(format!(
            "Unsupported Modrinth project type: {project_type}"
        )));
    }
    let sort = match sort.unwrap_or("relevance") {
        value @ ("relevance" | "downloads" | "follows" | "newest" | "updated") => value,
        value => {
            return Err(AppError::InvalidInput(format!(
                "Unsupported Modrinth sort: {value}"
            )));
        }
    };
    let game_version = game_version
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let loader = loader.map(str::trim).filter(|value| !value.is_empty());
    let cache_key = format!(
        "modrinth:search:{project_type}:{offset}:{limit}:{sort}:{}:{}:{}",
        game_version.unwrap_or(""),
        loader.unwrap_or(""),
        query.trim()
    );
    let mut facet_groups = vec![vec![format!("project_type:{project_type}")]];
    if let Some(version) = game_version {
        facet_groups.push(vec![format!("versions:{version}")]);
    }
    if matches!(project_type, "mod" | "modpack") {
        if let Some(loader) = loader {
            facet_groups.push(vec![format!("categories:{loader}")]);
        }
    }
    let facets = serde_json::to_string(&facet_groups)?;
    let response = state
        .http
        .get(SEARCH_URL)
        .query(&[
            ("query", query.trim().to_owned()),
            ("offset", offset.to_string()),
            ("limit", limit.to_string()),
            ("facets", facets),
            ("index", sort.to_owned()),
        ])
        .send()
        .await;
    let parsed = match response {
        Ok(response) => {
            let parsed: ApiSearchResult = response.error_for_status()?.json().await?;
            let value = convert(parsed);
            sqlx::query(
                "INSERT INTO content_cache(cache_key, source, payload_json) VALUES (?, 'modrinth', ?) \
                 ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            )
            .bind(&cache_key)
            .bind(serde_json::to_string(&value)?)
            .execute(&state.database)
            .await?;
            value
        }
        Err(error) => {
            let cached: Option<String> =
                sqlx::query_scalar("SELECT payload_json FROM content_cache WHERE cache_key = ?")
                    .bind(&cache_key)
                    .fetch_optional(&state.database)
                    .await?;
            match cached {
                Some(payload) => {
                    tracing::warn!(%error, "using cached Modrinth search response");
                    serde_json::from_str(&payload)?
                }
                None => return Err(error.into()),
            }
        }
    };
    Ok(parsed)
}

fn convert(result: ApiSearchResult) -> ModrinthSearchResult {
    ModrinthSearchResult {
        hits: result
            .hits
            .into_iter()
            .map(|project| ModrinthProject {
                project_id: project.project_id,
                slug: project.slug,
                title: project.title,
                description: project.description,
                project_type: project.project_type,
                icon_url: project.icon_url.and_then(approved_media_url),
                downloads: project.downloads,
                follows: project.follows,
                author: project.author,
                categories: project.categories,
                versions: project.versions,
                date_modified: project.date_modified,
            })
            .collect(),
        offset: result.offset,
        limit: result.limit,
        total_hits: result.total_hits,
    }
}

fn approved_media_url(value: String) -> Option<String> {
    let url = url::Url::parse(&value).ok()?;
    (url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("cdn.modrinth.com" | "staging-api.modrinth.com")
        ))
    .then_some(value)
}
