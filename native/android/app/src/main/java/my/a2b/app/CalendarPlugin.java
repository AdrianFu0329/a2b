package my.a2b.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.provider.CalendarContract;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Opens the phone's calendar with a new event filled in. The WebView can't save the .ics file that browsers
// download for "Leave later", so the app hands the event to the calendar instead.
@CapacitorPlugin(name = "Calendar")
public class CalendarPlugin extends Plugin {

    @PluginMethod
    public void add(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, call.getLong("begin"))
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, call.getLong("end"))
            .putExtra(CalendarContract.Events.TITLE, call.getString("title"))
            .putExtra(CalendarContract.Events.DESCRIPTION, call.getString("description"));
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No calendar app", "NO_CALENDAR");
        }
    }
}
