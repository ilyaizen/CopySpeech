// TTS backend abstraction.
// Each engine (CLI, HTTP, future sidecar) implements TtsBackend.
// The app doesn't care how speech is synthesized — only that it gets audio bytes back.

pub mod captions;
pub mod cartesia;
pub mod catalog;
pub mod cli;
pub mod edge;
pub mod elevenlabs;
mod elevenlabs_timing;
pub mod fish;
pub mod google;
pub mod http;
pub mod local_daemon;
pub mod microsoft;
pub mod mistral;
pub mod openai;
pub mod stream;
pub mod xai;

use stream::ChunkStream;

use thiserror::Error;

/// Run an async block to completion from synchronous code: on the current
/// Tokio runtime when the caller is inside one, otherwise on a fresh runtime.
fn block_on_async<F, T>(f: F) -> T
where
    F: std::future::Future<Output = T>,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => handle.block_on(f),
        Err(_) => {
            let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
            rt.block_on(f)
        }
    }
}

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum TtsError {
    #[error("TTS command failed: {0}")]
    CommandFailed(String),

    #[error("TTS output file not found: {0}")]
    OutputNotFound(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("TTS engine not available: {0}")]
    Unavailable(String),

    #[error("HTTP error: {0}")]
    Http(String),
}

/// Metadata for a voice option exposed in the settings UI.
#[derive(Debug, Clone, serde::Serialize)]
#[allow(dead_code)]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub default: Option<bool>,
    pub gender: Option<String>,
    pub preview_url: Option<String>,
    pub tags: Vec<String>,
}

/// The core abstraction. Every TTS engine implements this.
/// Kept intentionally small — synthesize text, get audio bytes.
pub trait TtsBackend: Send + Sync {
    /// Human-readable name for settings UI display.
    #[allow(dead_code)]
    fn name(&self) -> &str;

    /// Synthesize text into WAV audio bytes.
    /// Blocks until synthesis is complete (called from async context via spawn_blocking).
    ///
    /// Speed is intentionally NOT a parameter: playback speed is a frontend-only
    /// concern (applied via `audioEl.playbackRate`), mirroring how pitch is handled.
    /// Synthesis always runs at native speed; saved files do not bake in speed.
    fn synthesize(&self, text: &str, voice: &str) -> Result<Vec<u8>, TtsError>;

    fn synthesize_with_captions(
        &self,
        text: &str,
        voice: &str,
    ) -> Result<captions::SpeechAudio, TtsError> {
        self.synthesize(text, voice).map(Into::into)
    }

    /// Check if the engine binary/server is reachable.
    fn health_check(&self) -> Result<(), TtsError>;

    /// Load this engine's model ahead of the first utterance. Only local
    /// engines with a resident daemon do anything; everyone else is a no-op.
    #[allow(dead_code)]
    fn prewarm(&self, _voice: &str) {}

    /// Static claim: whether this backend (or model) can produce audio
    /// incrementally via [`TtsBackend::synthesize_streaming`]. Defaults to false
    /// for batch-only backends. The command layer picks the streaming path only
    /// when this and [`TtsBackend::runtime_ready`] both hold.
    fn supports_streaming(&self) -> bool {
        false
    }

    /// Whether streaming can start right now. Static claims stay in
    /// [`TtsBackend::supports_streaming`]; this covers warm-up state such as a
    /// local daemon that is still loading. Call sites require both.
    fn runtime_ready(&self) -> bool {
        true
    }

    /// Whether the failure this backend just returned must not be retried by
    /// the caller.
    ///
    /// The command layer retries transient failures twice. Some backends can
    /// tell that a retry would only make things worse — Edge answers a retried
    /// 429 with another 429 and escalates a *process-wide* cooldown, so three
    /// attempts for one user action leave every later reading penalised.
    /// Checked after an attempt fails, so it describes the most recent one.
    fn failure_is_final(&self) -> bool {
        false
    }

    /// Stream synthesized audio as PCM chunks.
    ///
    /// Only backends that override this and claim [`TtsBackend::supports_streaming`]
    /// are asked to stream. The default refuses instead of wrapping batch output,
    /// so a backend that is asked without a native stream fails loudly.
    #[allow(dead_code)]
    fn synthesize_streaming(&self, _text: &str, _voice: &str) -> Result<ChunkStream, TtsError> {
        Err(TtsError::Unavailable(format!(
            "{} has no native streaming",
            self.name()
        )))
    }

    /// File extension for the audio bytes returned by `synthesize` (e.g. "wav", "mp3").
    /// Defaults to "wav" — only override when the backend returns a non-WAV format.
    fn file_extension(&self) -> &str {
        "wav"
    }

    /// Resolve voice ID to human-readable name for display and filenames.
    /// Returns lowercase, filesystem-safe name.
    #[allow(dead_code)]
    fn voice_display_name(&self, voice_id: &str) -> String {
        voice_id.to_lowercase()
    }
}

#[cfg(test)]
pub(crate) mod test_http {
    use std::collections::{HashMap, VecDeque};
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    #[derive(Clone, Debug)]
    pub(crate) struct CapturedRequest {
        pub method: String,
        pub path: String,
        pub query: Option<String>,
        headers: HashMap<String, String>,
        #[allow(dead_code)]
        pub body: Vec<u8>,
    }

    impl CapturedRequest {
        pub(crate) fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .get(&name.to_ascii_lowercase())
                .map(String::as_str)
        }
    }

    pub(crate) struct TestServer {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<CapturedRequest>>>,
        shutdown: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl TestServer {
        pub(crate) fn start_one(status: u16, body: impl Into<Vec<u8>>) -> Self {
            Self::start(vec![(status, body.into())])
        }

        pub(crate) fn start(responses: Vec<(u16, Vec<u8>)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
            let addr = listener.local_addr().expect("local addr");
            let requests = Arc::new(Mutex::new(Vec::new()));
            let shutdown = Arc::new(AtomicBool::new(false));
            let mut queue = VecDeque::from(responses);

            let reqs_bg = Arc::clone(&requests);
            let stop_bg = Arc::clone(&shutdown);
            let worker = std::thread::spawn(move || loop {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                if stop_bg.load(Ordering::SeqCst) {
                    break;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut raw = Vec::new();
                let mut byte = [0u8; 1];
                while !raw.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut byte).is_err() {
                        break;
                    }
                    raw.push(byte[0]);
                }
                if !raw.ends_with(b"\r\n\r\n") {
                    continue;
                }
                let header_text = String::from_utf8_lossy(&raw);
                let mut lines = header_text.split("\r\n");
                let request_line = lines.next().unwrap_or("");
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("/");
                let (path, query) = match target.split_once('?') {
                    Some((p, q)) => (p.to_string(), Some(q.to_string())),
                    None => (target.to_string(), None),
                };

                let mut headers = HashMap::new();
                for line in lines {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some((k, v)) = line.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                    }
                }
                let content_len = headers
                    .get("content-length")
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let mut body = vec![0u8; content_len];
                if content_len > 0 && stream.read_exact(&mut body).is_err() {
                    continue;
                }

                reqs_bg.lock().unwrap().push(CapturedRequest {
                    method,
                    path,
                    query,
                    headers,
                    body,
                });

                let (status, resp_body) = queue
                    .pop_front()
                    .unwrap_or_else(|| (500, b"unexpected request".to_vec()));
                let reason = match status {
                    200 => "OK",
                    401 => "Unauthorized",
                    _ => "Response",
                };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    resp_body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&resp_body);
                let _ = stream.flush();
            });

            Self {
                addr,
                requests,
                shutdown,
                worker: Some(worker),
            }
        }

        pub(crate) fn uri(&self) -> String {
            format!("http://{}", self.addr)
        }

        pub(crate) fn requests(&self) -> Vec<CapturedRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(self.addr);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{block_on_async, TtsBackend, TtsError};

    struct BatchOnly;

    impl TtsBackend for BatchOnly {
        fn name(&self) -> &str {
            "batch-only"
        }

        fn synthesize(&self, _text: &str, _voice: &str) -> Result<Vec<u8>, TtsError> {
            Ok(Vec::new())
        }

        fn health_check(&self) -> Result<(), TtsError> {
            Ok(())
        }
    }

    #[test]
    fn backend_without_native_streaming_refuses_to_stream() {
        // Such a backend must fail loudly if asked, not silently wrap its batch output.
        let err = BatchOnly
            .synthesize_streaming("hi", "v")
            .err()
            .expect("batch-only backend must refuse to stream");
        assert!(
            matches!(&err, TtsError::Unavailable(reason) if reason.contains("no native streaming")),
            "{err}"
        );
    }

    #[test]
    fn block_on_async_works_with_and_without_ambient_runtime() {
        assert_eq!(block_on_async(async { 7 }), 7);

        let rt = tokio::runtime::Runtime::new().unwrap();
        let value = rt.block_on(async {
            tokio::task::spawn_blocking(|| block_on_async(async { 9 }))
                .await
                .unwrap()
        });
        assert_eq!(value, 9);
    }
}
