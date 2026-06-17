// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use keyring::Entry;

const KEYCHAIN_SERVICE: &str = "com.sally.alarm";

#[tauri::command]
fn save_token(account: String, token: String) -> Result<(), String> {
    Entry::new(KEYCHAIN_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .set_password(&token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_token(account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_token(account: String) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // 일반 창 앱으로 동작(Dock 아이콘 표시, 실행 시 창 표시).
            // 메뉴바 전용(Accessory) 모드는 창 표시 이슈로 보류.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_token,
            get_token,
            delete_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
