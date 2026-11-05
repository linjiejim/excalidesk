// 测 WKWebView 里 requestAnimationFrame 的实际帧率；--unlock 时关掉 PreferPageRenderingUpdatesNear60FPSEnabled
import Cocoa
import WebKit

let unlock = CommandLine.arguments.contains("--unlock")

final class Done: NSObject, WKScriptMessageHandler {
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    print("\(unlock ? "unlocked" : "default ")  \(m.body)"); fflush(stdout)
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let cfg = WKWebViewConfiguration()
let done = Done()
cfg.userContentController.add(done, name: "done")

if unlock {
  let featuresSel = NSSelectorFromString("_features")
  let setSel = NSSelectorFromString("_setEnabled:forFeature:")
  if WKPreferences.responds(to: featuresSel),
     let list = (WKPreferences.self as AnyObject).perform(featuresSel)?.takeUnretainedValue() as? [NSObject] {
    for f in list where (f.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" {
      typealias Fn = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
      unsafeBitCast(cfg.preferences.method(for: setSel), to: Fn.self)(cfg.preferences, setSel, false, f)
    }
  } else { print("private API not available") }
}

let html = """
<canvas id=c width=600 height=300></canvas><script>
const ctx = c.getContext('2d'); const ts = []; let t0;
function frame(t){ ctx.clearRect(0,0,600,300); ctx.fillRect((t/3)%600,100,40,40);
  if(!t0) t0=t; if(t-t0>1000) ts.push(t);
  if(t-t0<4000) requestAnimationFrame(frame);
  else { const d=[]; for(let i=1;i<ts.length;i++) d.push(ts[i]-ts[i-1]); d.sort((a,b)=>a-b);
    const fps=(ts.length-1)/((ts[ts.length-1]-ts[0])/1000);
    webkit.messageHandlers.done.postMessage(`rAF ${fps.toFixed(1)} fps, median frame ${d[d.length>>1].toFixed(2)} ms, screen ${screen.width}x${screen.height}@${devicePixelRatio}x`); } }
requestAnimationFrame(frame);
</script>
"""

let win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 600, height: 300),
                   styleMask: [.titled], backing: .buffered, defer: false)
win.title = "WKWebView rAF test"
let wv = WKWebView(frame: win.contentView!.bounds, configuration: cfg)
win.contentView = wv
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
wv.loadHTMLString(html, baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("timeout"); NSApp.terminate(nil) }
app.run()
