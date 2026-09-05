//! Use the OS permission and submission callbacks on macOS. The cross-platform
//! plugin reports granted unconditionally there and discards submission errors.

pub fn setup() {
    #[cfg(target_os = "macos")]
    macos::setup();
}

#[tauri::command]
pub async fn notification_permission(request: bool) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::permission(request).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok("unavailable".into())
    }
}

#[tauri::command]
pub async fn send_notification(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::send(title, body).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Err("Native macOS notifications are unavailable".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::Bool};
    use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSettings,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::{ptr::NonNull, sync::Mutex, time::Duration};
    use tokio::sync::oneshot;

    // Keep the weak native delegate alive for the application's lifetime.
    thread_local! {
        static DELEGATE: std::cell::OnceCell<Retained<NotificationDelegate>> = const { std::cell::OnceCell::new() };
    }

    objc2::define_class!(
        #[unsafe(super = NSObject)]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}
        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &objc2_user_notifications::UNNotification,
                completion: &block2::DynBlock<dyn Fn(objc2_user_notifications::UNNotificationPresentationOptions)>,
            ) {
                use objc2_user_notifications::UNNotificationPresentationOptions as Options;
                // Normal agent alerts are already suppressed by the frontend
                // while focused. Explicit test notifications should still show.
                completion.call((Options::Banner | Options::List | Options::Sound,));
            }
        }
    );

    pub fn setup() {
        use objc2::{ClassType, msg_send, runtime::ProtocolObject};
        let Some(center) = center() else { return };
        DELEGATE.with(|slot| {
            let delegate = slot.get_or_init(|| {
                // NSObject's inherited new method initializes this stateless class.
                unsafe { msg_send![NotificationDelegate::class(), new] }
            });
            center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
        });
    }

    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        // The framework raises an Objective-C exception in an unbundled dev
        // executable. Never borrow Terminal's notification identity instead.
        NSBundle::mainBundle().bundleIdentifier()?;
        Some(UNUserNotificationCenter::currentNotificationCenter())
    }

    async fn receive<T>(rx: oneshot::Receiver<T>) -> Result<T, String> {
        tokio::time::timeout(Duration::from_secs(120), rx)
            .await
            .map_err(|_| "Notification request timed out. Check System Settings and try again.".to_string())?
            .map_err(|_| "The notification service did not respond. Try again.".to_string())
    }

    async fn status() -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        {
            let Some(center) = center() else { return Ok("unavailable".into()) };
            let tx = Mutex::new(Some(tx));
            let callback = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // The OS owns this settings object throughout the callback.
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                let value = match status {
                    UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => "granted",
                    UNAuthorizationStatus::Denied => "denied",
                    _ => "default",
                };
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(value.to_string());
                }
            });
            center.getNotificationSettingsWithCompletionHandler(&callback);
        }
        receive(rx).await
    }

    pub async fn permission(request: bool) -> Result<String, String> {
        let current = status().await?;
        if !request || current != "default" {
            return Ok(current);
        }
        let (tx, rx) = oneshot::channel();
        {
            let Some(center) = center() else { return Ok("unavailable".into()) };
            let tx = Mutex::new(Some(tx));
            let callback = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
                let result = error_result(error);
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(result);
                }
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &callback,
            );
        }
        receive(rx).await??;
        status().await
    }

    fn error_result(error: *mut NSError) -> Result<(), String> {
        // NSError is valid for the duration of the OS completion callback.
        match unsafe { error.as_ref() } {
            Some(error) => Err(error.localizedDescription().to_string()),
            None => Ok(()),
        }
    }

    pub async fn send(title: String, body: String) -> Result<(), String> {
        if status().await? != "granted" {
            return Err("Allow Kybern notifications in System Settings.".into());
        }
        let (tx, rx) = oneshot::channel();
        {
            let center = center().ok_or("Open the packaged Kybern app to send notifications.")?;
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&title));
            content.setBody(&NSString::from_str(&body));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
            let tx = Mutex::new(Some(tx));
            let callback = RcBlock::new(move |error: *mut NSError| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(error_result(error));
                }
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        }
        receive(rx).await?
    }
}
