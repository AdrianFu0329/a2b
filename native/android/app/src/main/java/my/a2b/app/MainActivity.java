package my.a2b.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationPermission.class);
        registerPlugin(CalendarPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
