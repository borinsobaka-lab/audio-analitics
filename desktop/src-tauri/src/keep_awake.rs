//! Prevent system sleep while recording.
//! macOS: spawn `caffeinate -dims` for the app's lifetime of the recording.
//! Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED).

pub struct KeepAwake {
    #[cfg(target_os = "macos")]
    child: Option<std::process::Child>,
}

impl KeepAwake {
    #[cfg(target_os = "macos")]
    pub fn acquire() -> Self {
        let child = std::process::Command::new("caffeinate")
            .arg("-dims")
            .spawn()
            .map_err(|e| log::warn!("caffeinate failed: {e}"))
            .ok();
        Self { child }
    }

    #[cfg(target_os = "windows")]
    pub fn acquire() -> Self {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        };
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        Self {}
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn acquire() -> Self {
        Self {}
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(child) = &mut self.child {
            let _ = child.kill();
        }
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}
