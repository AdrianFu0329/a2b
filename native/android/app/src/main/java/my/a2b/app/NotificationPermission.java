package my.a2b.app;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// Asks to show notifications (Android 13 and later). Without it directions still run with the screen off, but
// Android hides the notification that says A2B is giving them.
@CapacitorPlugin(
    name = "NotificationPermission",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
)
public class NotificationPermission extends Plugin {

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("notifications", call, "answered");
    }

    @PermissionCallback
    private void answered(PluginCall call) {
        call.resolve();
    }
}
