use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub fn parse_shortcut(hotkey: &str) -> Result<Option<Shortcut>, String> {
    let trimmed = hotkey.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = trimmed.split('+').map(str::trim).filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return Err("hotkey_requires_modifier".into());
    }
    let mut mods = Modifiers::empty();
    let mut key = None;
    let mut saw_modifier = false;
    for part in parts {
        match part.to_ascii_lowercase().as_str() {
            "commandorcontrol" => {
                mods |= command_or_control();
                saw_modifier = true;
            }
            "command" | "cmd" | "super" | "meta" => {
                mods |= Modifiers::SUPER;
                saw_modifier = true;
            }
            "control" | "ctrl" => {
                mods |= Modifiers::CONTROL;
                saw_modifier = true;
            }
            "alt" | "option" => {
                mods |= Modifiers::ALT;
                saw_modifier = true;
            }
            "shift" => {
                mods |= Modifiers::SHIFT;
                saw_modifier = true;
            }
            other => {
                if key.is_some() {
                    return Err("invalid_hotkey".into());
                }
                key = Some(parse_code(other).ok_or_else(|| "invalid_hotkey".to_string())?);
            }
        }
    }
    if !saw_modifier {
        return Err("hotkey_requires_modifier".into());
    }
    Ok(Some(Shortcut::new(Some(mods), key.ok_or_else(|| "invalid_hotkey".to_string())?)))
}

fn command_or_control() -> Modifiers {
    if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    }
}

fn parse_code(token: &str) -> Option<Code> {
    if token.len() == 1 {
        let ch = token.chars().next()?.to_ascii_uppercase();
        return match ch {
            'A' => Some(Code::KeyA),
            'B' => Some(Code::KeyB),
            'C' => Some(Code::KeyC),
            'D' => Some(Code::KeyD),
            'E' => Some(Code::KeyE),
            'F' => Some(Code::KeyF),
            'G' => Some(Code::KeyG),
            'H' => Some(Code::KeyH),
            'I' => Some(Code::KeyI),
            'J' => Some(Code::KeyJ),
            'K' => Some(Code::KeyK),
            'L' => Some(Code::KeyL),
            'M' => Some(Code::KeyM),
            'N' => Some(Code::KeyN),
            'O' => Some(Code::KeyO),
            'P' => Some(Code::KeyP),
            'Q' => Some(Code::KeyQ),
            'R' => Some(Code::KeyR),
            'S' => Some(Code::KeyS),
            'T' => Some(Code::KeyT),
            'U' => Some(Code::KeyU),
            'V' => Some(Code::KeyV),
            'W' => Some(Code::KeyW),
            'X' => Some(Code::KeyX),
            'Y' => Some(Code::KeyY),
            'Z' => Some(Code::KeyZ),
            '0' => Some(Code::Digit0),
            '1' => Some(Code::Digit1),
            '2' => Some(Code::Digit2),
            '3' => Some(Code::Digit3),
            '4' => Some(Code::Digit4),
            '5' => Some(Code::Digit5),
            '6' => Some(Code::Digit6),
            '7' => Some(Code::Digit7),
            '8' => Some(Code::Digit8),
            '9' => Some(Code::Digit9),
            _ => None,
        };
    }
    match token {
        "escape" => Some(Code::Escape),
        "tab" => Some(Code::Tab),
        "space" => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "backspace" => Some(Code::Backspace),
        "delete" => Some(Code::Delete),
        "home" => Some(Code::Home),
        "end" => Some(Code::End),
        "pageup" => Some(Code::PageUp),
        "pagedown" => Some(Code::PageDown),
        "insert" => Some(Code::Insert),
        "up" => Some(Code::ArrowUp),
        "down" => Some(Code::ArrowDown),
        "left" => Some(Code::ArrowLeft),
        "right" => Some(Code::ArrowRight),
        "minus" => Some(Code::Minus),
        "equal" => Some(Code::Equal),
        "f1" => Some(Code::F1),
        "f2" => Some(Code::F2),
        "f3" => Some(Code::F3),
        "f4" => Some(Code::F4),
        "f5" => Some(Code::F5),
        "f6" => Some(Code::F6),
        "f7" => Some(Code::F7),
        "f8" => Some(Code::F8),
        "f9" => Some(Code::F9),
        "f10" => Some(Code::F10),
        "f11" => Some(Code::F11),
        "f12" => Some(Code::F12),
        _ => None,
    }
}
