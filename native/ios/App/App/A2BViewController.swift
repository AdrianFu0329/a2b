import Capacitor

// The app's web view controller: registers A2B's own plugins (the npm ones register themselves).
class A2BViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(CalendarPlugin())
    }
}
