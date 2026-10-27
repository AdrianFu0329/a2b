import Capacitor
import EventKit
import EventKitUI

// Opens the phone's calendar with a new event filled in. The WebView can't save the .ics file that browsers
// download for "Leave later", so the app hands the event to the calendar instead. The system editor needs no
// calendar permission: the person adds (or cancels) the event themselves.
@objc(CalendarPlugin)
public class CalendarPlugin: CAPPlugin, CAPBridgedPlugin, EKEventEditViewDelegate {
    public let identifier = "CalendarPlugin"
    public let jsName = "Calendar"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "add", returnType: CAPPluginReturnPromise)]
    private let store = EKEventStore()

    @objc func add(_ call: CAPPluginCall) {
        guard let begin = call.getDouble("begin"), let end = call.getDouble("end") else {
            call.reject("Missing begin or end")
            return
        }
        DispatchQueue.main.async {
            let event = EKEvent(eventStore: self.store)
            event.title = call.getString("title")
            event.notes = call.getString("description")
            event.startDate = Date(timeIntervalSince1970: begin / 1000)
            event.endDate = Date(timeIntervalSince1970: end / 1000)
            event.addAlarm(EKAlarm(relativeOffset: -10 * 60)) // as the browser's .ics does: 10 minutes before leaving
            let editor = EKEventEditViewController()
            editor.eventStore = self.store
            editor.event = event
            editor.editViewDelegate = self
            self.bridge?.viewController?.present(editor, animated: true)
            call.resolve()
        }
    }

    public func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        controller.dismiss(animated: true)
    }
}
