use reqwest::{ClientBuilder, Url};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Respect the OS proxy for public model APIs, but never send a local model
/// endpoint through an ambient proxy (which may not understand LAN/Tailnet
/// addresses, and on macOS does not necessarily honor proxy exclusions).
pub fn client_builder_for_endpoint(endpoint: &str) -> ClientBuilder {
    let builder = reqwest::Client::builder();
    if is_direct_endpoint(endpoint) {
        builder.no_proxy()
    } else {
        builder
    }
}

fn is_direct_endpoint(endpoint: &str) -> bool {
    let Ok(url) = Url::parse(endpoint) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => direct_ipv4(ip),
            IpAddr::V6(ip) => direct_ipv6(ip),
        };
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".ts.net")
        || !host.contains('.')
}

fn direct_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn direct_ipv6(ip: Ipv6Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()
        || ip.is_unspecified()
        || octets[0] & 0xfe == 0xfc // Unique local (fc00::/7).
        || (octets[0] == 0xfe && octets[1] & 0xc0 == 0x80) // Link local (fe80::/10).
}

#[cfg(test)]
mod tests {
    use super::{client_builder_for_endpoint, is_direct_endpoint};
    use std::{env, io::Read, io::Write, net::TcpListener, process::Command, thread};

    #[test]
    fn local_model_endpoints_bypass_ambient_proxy() {
        for url in [
            "http://127.0.0.1:8080/v1",
            "http://[::1]:8080/v1",
            "http://192.168.2.103:8000/v1",
            "http://172.16.0.1/v1",
            "http://10.0.0.1/v1",
            "http://100.101.102.103:8000/v1",
            "http://[fd7a:115c:a1e0::1]:8000/v1",
            "http://WZU_Server:8000/v1",
            "http://model.local/v1",
            "http://model.tailnet.ts.net/v1",
        ] {
            assert!(is_direct_endpoint(url), "{url}");
        }
    }

    #[test]
    fn public_model_endpoints_keep_system_proxy() {
        for url in [
            "https://api.deepseek.com/v1",
            "https://api.openai.com/v1",
            "https://example.org/v1",
            "not a URL",
        ] {
            assert!(!is_direct_endpoint(url), "{url}");
        }
    }

    #[test]
    fn ambient_proxy_is_used_for_public_api_but_not_local_model() {
        const CHILD: &str = "XHARNESS_PROXY_ROUTING_TEST_CHILD";
        if env::var_os(CHILD).is_none() {
            // Proxy environment is process-wide. Isolate this test so parallel
            // provider tests never inherit its deliberately broken proxy.
            let output = Command::new(env::current_exe().unwrap())
                .arg("--exact")
                .arg("network::tests::ambient_proxy_is_used_for_public_api_but_not_local_model")
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        fn reply(listener: TcpListener, body: &'static str) -> thread::JoinHandle<()> {
            thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut buffer = [0u8; 1024];
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            })
        }

        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_task = reply(proxy, "proxy");
        env::set_var("HTTP_PROXY", format!("http://{proxy_addr}"));
        env::set_var("http_proxy", format!("http://{proxy_addr}"));
        env::remove_var("NO_PROXY");
        env::remove_var("no_proxy");

        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let local_url = format!("http://{}/v1/models", origin.local_addr().unwrap());
        let origin_task = reply(origin, "direct");

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let public_url = "http://model-api.example.invalid/v1/models";
            let public = client_builder_for_endpoint(public_url).build().unwrap();
            assert_eq!(
                public
                    .get(public_url)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "proxy"
            );
            let local = client_builder_for_endpoint(&local_url).build().unwrap();
            assert_eq!(
                local
                    .get(local_url)
                    .send()
                    .await
                    .unwrap()
                    .text()
                    .await
                    .unwrap(),
                "direct"
            );
        });
        proxy_task.join().unwrap();
        origin_task.join().unwrap();
    }
}
