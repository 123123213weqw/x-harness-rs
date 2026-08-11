import AppKit
import WebKit

@MainActor final class Driver: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let web: WKWebView
    let out: String
    var step = 0
    var attempts = 0
    init(path: String) {
        out = URL(fileURLWithPath: path).deletingLastPathComponent().path
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: NSRect(x:0,y:0,width:1280,height:820),configuration:config)
        window = NSWindow(contentRect:NSRect(x:20,y:30,width:1280,height:820),styleMask:[.titled,.closable,.resizable,.miniaturizable,.fullSizeContentView],backing:.buffered,defer:false)
        super.init()
        window.title = "XHarness Full Graph Diagnostic — fixture only"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        web.autoresizingMask = [.width,.height]
        window.contentView?.addSubview(web)
        web.navigationDelegate = self
        window.orderFront(nil)
        web.load(URLRequest(url: URL(string:path)!))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        openSettings()
    }
    func openSettings() {
        attempts += 1
        web.evaluateJavaScript("""
        (()=>{
          const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Settings'||x.getAttribute('aria-label')==='Settings');
          if (!b) return false;
          b.click();
          window.record=()=>{
            const d=document.querySelector('dialog:modal');
            const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
            return {viewport:{width:innerWidth,height:innerHeight,client:document.documentElement.clientWidth},body:rect(document.body),dialog:rect(d),mask:rect(d?.querySelector('._8OspXW_mask')),panel:rect(d?.querySelector('._8OspXW_panel'))};
          };
          return true;
        })()
        """) { value,error in
            if value as? Bool == true {
                DispatchQueue.main.asyncAfter(deadline:.now()+0.4) {
                    self.sample("General") {
                        self.section("Profile") {
                            self.section("Archived chats") {
                                self.section("General") {
                                    self.section("Profile") {
                                        self.window.zoom(nil)
                                        DispatchQueue.main.asyncAfter(deadline:.now()+0.5) {
                                            self.sample("Profile-native-zoom") { self.resize(NSSize(width:1420,height:800),name:"larger",animated:false) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if self.attempts < 40 {
                DispatchQueue.main.asyncAfter(deadline:.now()+0.2) { self.openSettings() }
            } else { print("BOOT_FAILED", error?.localizedDescription ?? "no settings button"); NSApplication.shared.terminate(nil) }
        }
    }
    func section(_ name: String, next: @escaping ()->Void) {
        let encoded = String(data: try! JSONSerialization.data(withJSONObject: name, options:.fragmentsAllowed), encoding:.utf8)!
        web.evaluateJavaScript("[...document.querySelectorAll('dialog:modal button')].find(b=>b.textContent.trim()===\(encoded)).click()") { _,error in
            if let error { print("SECTION_ERROR",name,error); NSApplication.shared.terminate(nil); return }
            DispatchQueue.main.asyncAfter(deadline:.now()+0.15) { self.sample(name,next:next) }
        }
    }
    func resize(_ size: NSSize, name: String, animated: Bool) {
        if animated {
            let frame=window.frameRect(forContentRect:NSRect(origin:window.frame.origin,size:size))
            window.setFrame(frame,display:true,animate:true)
        } else { window.setContentSize(size) }
        DispatchQueue.main.asyncAfter(deadline:.now()+0.35) {
            self.sample(name) {
                self.step += 1
                switch self.step {
                case 1: self.resize(NSSize(width:960,height:700),name:"smaller",animated:false)
                case 2: self.resize(NSSize(width:1420,height:880),name:"animated-larger",animated:true)
                case 3: self.resize(NSSize(width:960,height:700),name:"animated-smaller",animated:true)
                case 4:
                    self.web.evaluateJavaScript("document.querySelector('dialog:modal').close();document.querySelector('dialog').showModal();") { _,_ in
                        self.sample("reopened") { NSApplication.shared.terminate(nil) }
                    }
                default: NSApplication.shared.terminate(nil)
                }
            }
        }
    }
    func sample(_ name: String, next: @escaping ()->Void) {
        web.evaluateJavaScript("JSON.stringify(record())") { value,error in
            print(name, "native",self.window.contentView!.bounds.size,self.web.bounds.size,"js",value ?? "nil","error",error?.localizedDescription ?? "none")
            fflush(stdout)
            next()
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let driver = MainActor.assumeIsolated { Driver(path:CommandLine.arguments[1]) }
DispatchQueue.main.asyncAfter(deadline:.now()+45) { print("TIMEOUT");fflush(stdout);app.terminate(nil) }
app.run()
