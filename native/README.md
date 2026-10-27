# A2B for Android

A [Capacitor](https://capacitorjs.com) shell around the web app, so A2B can be installed as an Android app and keep
giving directions with the screen off or another app on top. Status: a spike, for testing; not on the Play Store.

The app loads the live web app (`https://a2b-beta.pages.dev`) rather than a bundled copy, so sign-in, `/api` and shop
search work unchanged and a web deploy updates the app too. Inside the app, `public/native.js` swaps these browser
features for native ones:

| Browser | In the app | Why |
| --- | --- | --- |
| `speechSynthesis` | `@capacitor-community/text-to-speech` | Android's WebView has no speech voices at all. |
| `watchPosition` | `@capacitor-community/background-geolocation` | GPS stops once the app is out of sight. While driving it runs as a foreground service, with a notification. |
| Wake Lock | `@capacitor-community/keep-awake` | Keeps the screen on while driving. |
| `navigator.share` / clipboard | `@capacitor/share` | The WebView has neither, so sharing a drive opens the phone's share sheet. |
| `.ics` download ("Leave later") | `CalendarPlugin.java` | The WebView can't save files, so the phone's calendar opens with the event filled in. |
| Browser back | `@capacitor/app` | Without it Android's back button closes the app. Back now closes what's open, as in a browser; with nothing open the app goes to the background and a drive carries on. |

`capacitor.config.js` sets `useLegacyBridge`, so plugin results reach the page through `evaluateJavascript`. With the
default bridge (`postMessage`), the WebView stops delivering them about a minute after the screen goes off: the GPS
keeps running but the page hears nothing, and directions stop until the app is opened again.

## Build and run

You need Node.js 22.13+, JDK 21 and the Android SDK (platform 36).

```bash
cd native
npm install
npm run sync                                  # copy the config and plugins into android/
cd android && ./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

To try web changes before they're deployed, point the app at your computer:

```bash
npm run dev                                   # in the repo root
adb reverse tcp:8787 tcp:8787
A2B_URL=http://localhost:8787 npm run sync    # in native/, then build and install as above
```

Debug builds can be inspected from `chrome://inspect` on your computer.

On first launch the app asks for location, then (Android 13+) to show notifications, so the "A2B is giving
directions" notification is visible while driving with the screen off. `NotificationPermission.java` is the small
plugin that asks.

The launcher, themed and notification icons are vector drawables drawn from `public/icon.svg`
(`res/drawable/ic_launcher_*.xml`, `ic_notification.xml`), with PNG copies of `public/icon-512.png` for Android 7.

## Not done yet

- The splash screen on Android 11 and older is still Capacitor's (Android 12+ shows the A2B icon).
- A signed release build, the Play Store listing, and its background location declaration.
- iOS.
