use serde::Serialize;

use crate::comms::mattermost::MattermostClient;

#[derive(Serialize)]
pub struct CommsTestResult {
    pub ok: bool,
    pub bot_username: String,
}

/// Test a comms (Mattermost) server URL + bot token pair. Takes the values as
/// arguments — not from saved preferences — so the Preferences UI can test
/// before the user commits them.
#[tauri::command]
pub async fn comms_test_connection(
    server_url: String,
    bot_token: String,
) -> Result<CommsTestResult, String> {
    if server_url.trim().is_empty() || bot_token.trim().is_empty() {
        return Err("enter a server URL and bot token first".to_string());
    }
    let client = MattermostClient::new(&server_url, &bot_token, reqwest::Client::new());
    let me = client.me().await.map_err(|e| e.to_string())?;
    Ok(CommsTestResult {
        ok: true,
        bot_username: me.username,
    })
}

#[derive(Serialize)]
pub struct BotChannel {
    pub id: String,
    pub display_name: String,
    /// Team url-name — needed to build permalinks for picked-up threads.
    pub team_name: String,
    pub team_display_name: String,
}

/// Channels the configured bot is a member of (open/private only — no DMs/groups),
/// for the chat-monitoring picker. Uses the saved preferences.
#[tauri::command]
pub async fn comms_list_bot_channels(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<Vec<BotChannel>, String> {
    let client = crate::comms::client_from_prefs(&state, reqwest::Client::new())
        .map_err(|e| e.to_string())?;
    let teams = client.my_teams().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for team in &teams {
        let channels = client
            .my_team_channels(&team.id)
            .await
            .map_err(|e| e.to_string())?;
        for ch in channels {
            if ch.channel_type == "O" || ch.channel_type == "P" {
                out.push(BotChannel {
                    id: ch.id,
                    display_name: if ch.display_name.is_empty() { ch.name } else { ch.display_name },
                    team_name: team.name.clone(),
                    team_display_name: if team.display_name.is_empty() { team.name.clone() } else { team.display_name.clone() },
                });
            }
        }
    }
    out.sort_by(|a, b| (&a.team_display_name, &a.display_name).cmp(&(&b.team_display_name, &b.display_name)));
    Ok(out)
}
