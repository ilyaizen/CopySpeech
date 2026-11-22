// Streaming contract shared by all TTS backends.
//
// A backend that supports intra-request streaming produces PCM chunks through
// an unbounded channel; the command layer forwards them to the frontend without
// knowing which engine produced them. Backends without native streaming refuse
// `synthesize_streaming`, and the command layer keeps them on the batch path.

use serde::Serialize;
use std::sync::mpsc;
use std::time::Duration;

use super::TtsError;
use crate::audio::wav::{parse_wav_header, WavInfo};

/// Format metadata describing the PCM carried by a [`ChunkStream`].
/// Serialized verbatim in audio-stream-chunk events.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct AudioFormatMeta {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

impl From<&WavInfo> for AudioFormatMeta {
    fn from(info: &WavInfo) -> Self {
        Self {
            sample_rate: info.sample_rate,
            channels: info.channels,
            bits_per_sample: info.bits_per_sample,
        }
    }
}

/// One item delivered by a [`ChunkStream`].
#[derive(Debug, Clone, PartialEq)]
pub enum ChunkItem {
    /// Raw PCM payload in the format described by the stream's meta.
    Pcm(Vec<u8>),
    /// Complete snapshot so far; offsets and times are relative to this request.
    Captions(super::captions::CaptionAlignment),
    /// Rejected optional metadata invalidates the retained snapshot, not audio.
    ClearCaptions,
    /// The synthesis failed mid-stream; carries a human-readable reason.
    Failed(String),
}

/// A sequence of PCM chunks plus the format needed to play them.
///
/// The receiver side of an unbounded mpsc channel. Channel close signals
/// end-of-stream; a mid-stream failure arrives as a [`ChunkItem::Failed`].
pub struct ChunkStream {
    /// Consumed by the command layer when emitting audio-stream-chunk events
    /// (later slice tasks); tests assert it here.
    #[allow(dead_code)]
    pub meta: AudioFormatMeta,
    rx: mpsc::Receiver<ChunkItem>,
}

impl ChunkStream {
    /// Wrap a receiver into a stream. Used by producers (backends) and tests.
    #[allow(dead_code)]
    pub fn new(meta: AudioFormatMeta, rx: mpsc::Receiver<ChunkItem>) -> Self {
        Self { meta, rx }
    }

    /// Block until the next chunk. Returns `None` once the producer closed
    /// the channel (end of stream).
    #[allow(dead_code)]
    pub fn recv(&self) -> Option<ChunkItem> {
        self.rx.recv().ok()
    }

    /// Block up to `timeout` for the next chunk so the consumer can enforce
    /// an idle timeout between chunks.
    ///
    /// - `Ok(Some(item))` — a chunk arrived in time.
    /// - `Ok(None)` — producer closed the channel: end of stream.
    /// - `Err(RecvTimeoutError::Timeout)` — no chunk within `timeout`.
    /// - `Err(RecvTimeoutError::Disconnected)` — producer closed while waiting.
    #[allow(dead_code)]
    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<Option<ChunkItem>, mpsc::RecvTimeoutError> {
        match self.rx.recv_timeout(timeout) {
            Ok(item) => Ok(Some(item)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(mpsc::RecvTimeoutError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(self.rx.try_recv().ok()),
        }
    }
}

/// Producer side of a [`ChunkStream`], handed to the closure given to
/// [`spawn_stream`].
pub struct ChunkSink {
    tx: mpsc::Sender<ChunkItem>,
}

impl ChunkSink {
    /// Returns false once the consumer dropped the stream (stop or abort). The
    /// producer should stop pulling its source then.
    pub fn send(&self, item: ChunkItem) -> bool {
        self.tx.send(item).is_ok()
    }
}

/// Run a streaming producer on a worker thread and return the stream it feeds.
///
/// Each backend supplies only its engine-specific producer. An `Err` from the
/// producer arrives as one `ChunkItem::Failed`, and the stream then closes.
/// A producer that needs its raw message (no `HTTP error:` prefix) sends
/// `ChunkItem::Failed` through the sink itself and returns `Ok(())`. ElevenLabs
/// does this so its messages stay as they were.
pub fn spawn_stream<F, Fut>(meta: AudioFormatMeta, produce: F) -> ChunkStream
where
    F: FnOnce(ChunkSink) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), TtsError>>,
{
    let (tx, rx) = mpsc::channel();
    let failure_tx = tx.clone();
    std::thread::spawn(move || {
        let result = super::block_on_async(produce(ChunkSink { tx }));
        if let Err(error) = result {
            log::error!("[TTS] {error}");
            let _ = failure_tx.send(ChunkItem::Failed(error.to_string()));
        }
    });
    ChunkStream::new(meta, rx)
}

/// Build a single-chunk [`ChunkStream`] from one complete batch result.
///
/// Used by the CLI when no daemon stream is available (cold, busy, or gone):
/// the one-shot output is delivered as exactly one `Pcm` chunk.
pub fn chunk_stream_from_speech(
    speech: super::captions::SpeechAudio,
) -> Result<ChunkStream, TtsError> {
    let wav = speech.bytes;
    let info = parse_wav_header(&wav).map_err(TtsError::Http)?;

    let data_start = info.data_offset;
    let data_end = data_start + info.data_size;
    if data_end > wav.len() || info.data_size == 0 {
        log::error!(
            "[TTS] WAV data chunk out of bounds (offset {}, size {}, buffer {} bytes)",
            data_start,
            info.data_size,
            wav.len()
        );
        return Err(TtsError::Http(
            "WAV data chunk extends beyond file".to_string(),
        ));
    }

    let pcm = wav[data_start..data_end].to_vec();
    log::debug!(
        "[TTS] Batch-wrapped stream: {} PCM bytes, {} Hz / {} ch / {} bit",
        pcm.len(),
        info.sample_rate,
        info.channels,
        info.bits_per_sample
    );

    let (tx, rx) = mpsc::channel();
    if let Some(captions) = speech.captions {
        match captions.validate() {
            Ok(()) => {
                let _ = tx.send(ChunkItem::Captions(captions));
            }
            Err(error) => log::warn!("Ignoring invalid batch captions: {error}"),
        }
    }
    let _ = tx.send(ChunkItem::Pcm(pcm));
    drop(tx); // closing the sender signals end-of-stream after the single chunk

    Ok(ChunkStream {
        meta: AudioFormatMeta::from(&info),
        rx,
    })
}

/// Collect the same native stream when playback is configured for batch mode.
pub fn collect_speech(stream: ChunkStream) -> Result<super::captions::SpeechAudio, TtsError> {
    let mut pcm = Vec::new();
    let mut captions = None;
    while let Some(item) = stream.recv() {
        match item {
            ChunkItem::Pcm(bytes) => pcm.extend_from_slice(&bytes),
            ChunkItem::Captions(value) => {
                captions = match value.validate() {
                    Ok(()) => Some(value),
                    Err(error) => {
                        log::warn!("Ignoring invalid stream captions: {error}");
                        None
                    }
                };
            }
            ChunkItem::ClearCaptions => captions = None,
            ChunkItem::Failed(reason) => return Err(TtsError::Http(reason)),
        }
    }
    if pcm.is_empty() {
        return Err(TtsError::Http("Stream produced no audio".into()));
    }
    Ok(super::captions::SpeechAudio {
        bytes: pcm_to_wav(&pcm, &stream.meta),
        captions,
    })
}

/// Wrap raw PCM bytes into a minimal canonical WAV container (44-byte header).
///
/// Used by the command layer to package accumulated streaming PCM into a
/// single WAV for history, cache, and HUD envelope computation.
pub fn pcm_to_wav(pcm: &[u8], meta: &AudioFormatMeta) -> Vec<u8> {
    let byte_rate =
        meta.sample_rate * u32::from(meta.channels) * u32::from(meta.bits_per_sample) / 8;
    let block_align = meta.channels * meta.bits_per_sample / 8;

    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format tag
    wav.extend_from_slice(&meta.channels.to_le_bytes());
    wav.extend_from_slice(&meta.sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&meta.bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid WAV: RIFF header + fmt chunk + data chunk.
    fn build_wav(sample_rate: u32, channels: u16, bits_per_sample: u16, pcm: &[u8]) -> Vec<u8> {
        let fmt = vec![
            &1u16.to_le_bytes()[..],
            &channels.to_le_bytes()[..],
            &sample_rate.to_le_bytes()[..],
            &(sample_rate * u32::from(channels) * u32::from(bits_per_sample) / 8).to_le_bytes()[..],
            &(channels * bits_per_sample / 8).to_le_bytes()[..],
            &bits_per_sample.to_le_bytes()[..],
        ]
        .concat();

        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        let riff_size = (4 + 8 + fmt.len() + 8 + pcm.len()) as u32;
        wav.extend_from_slice(&riff_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        wav.extend_from_slice(&fmt);
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(pcm);
        wav
    }

    fn pcm_meta() -> AudioFormatMeta {
        AudioFormatMeta {
            sample_rate: 24000,
            channels: 1,
            bits_per_sample: 16,
        }
    }

    #[test]
    fn wav_and_batch_stream_round_trip_preserves_meta_and_captions() {
        let captions = super::super::captions::CaptionAlignment {
            text: "Hi".into(),
            words: vec![super::super::captions::WordTiming {
                text_start: 0,
                text_end: 2,
                start_ms: 1.0,
                end_ms: 2.0,
            }],
        };
        let bytes = build_wav(8000, 1, 16, &[0; 48]);
        let speech = collect_speech(
            chunk_stream_from_speech(super::super::captions::SpeechAudio {
                bytes: bytes.clone(),
                captions: Some(captions.clone()),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(speech.bytes, bytes);
        assert_eq!(speech.captions, Some(captions));

        let pcm = vec![0u8, 1, 2, 3, 254, 255];
        let stream = chunk_stream_from_speech(build_wav(44100, 1, 16, &pcm).into()).unwrap();
        assert_eq!(
            (stream.meta.sample_rate, stream.meta.channels, stream.meta.bits_per_sample),
            (44100, 1, 16)
        );
        assert_eq!(stream.recv(), Some(ChunkItem::Pcm(pcm)));
        assert!(stream.recv().is_none());

        let stereo = AudioFormatMeta {
            sample_rate: 24000,
            channels: 2,
            bits_per_sample: 16,
        };
        let pcm2 = vec![7u8; 40];
        let round = chunk_stream_from_speech(pcm_to_wav(&pcm2, &stereo).into()).unwrap();
        assert_eq!(round.meta.channels, 2);
        assert_eq!(round.recv(), Some(ChunkItem::Pcm(pcm2)));
    }

    #[test]
    fn malformed_input_is_rejected() {
        assert!(chunk_stream_from_speech(Vec::<u8>::new().into()).is_err());

        let mut junk = b"RIFF\x24\x00\x00\x00JUNK".to_vec();
        junk.resize(64, 0);
        assert!(chunk_stream_from_speech(junk.into()).is_err());
    }

    #[test]
    fn invalid_or_cleared_captions_preserve_pcm() {
        let valid = super::super::captions::CaptionAlignment {
            text: "Hi".into(),
            words: vec![super::super::captions::WordTiming {
                text_start: 0,
                text_end: 2,
                start_ms: 0.0,
                end_ms: 0.1,
            }],
        };

        let mut bad_offset = valid.clone();
        bad_offset.words[0].text_end = 3;
        let batch_bytes = build_wav(8000, 1, 16, &[1, 2, 3, 4]);
        let batch = collect_speech(
            chunk_stream_from_speech(super::super::captions::SpeechAudio {
                bytes: batch_bytes.clone(),
                captions: Some(bad_offset),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(batch.bytes, batch_bytes);
        assert_eq!(batch.captions, None);

        let mut neg_ms = valid.clone();
        neg_ms.words[0].start_ms = -1.0;
        for clear_item in [ChunkItem::Captions(neg_ms), ChunkItem::ClearCaptions] {
            let (tx, rx) = mpsc::channel();
            for item in [
                ChunkItem::Captions(valid.clone()),
                ChunkItem::Pcm(vec![1, 2]),
                clear_item,
                ChunkItem::Pcm(vec![3, 4]),
            ] {
                tx.send(item).unwrap();
            }
            drop(tx);
            let meta = AudioFormatMeta {
                sample_rate: 8000,
                channels: 1,
                bits_per_sample: 16,
            };
            let speech = collect_speech(ChunkStream::new(meta, rx)).unwrap();
            assert_eq!(speech.bytes, batch_bytes);
            assert_eq!(speech.captions, None);
        }

        let next = collect_speech(
            chunk_stream_from_speech(super::super::captions::SpeechAudio {
                bytes: build_wav(8000, 1, 16, &[5, 6]),
                captions: Some(valid.clone()),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(next.captions, Some(valid));
    }

    #[test]
    fn collection_still_rejects_empty_audio_and_explicit_failure() {
        for items in [
            vec![],
            vec![
                ChunkItem::Pcm(vec![1, 2]),
                ChunkItem::Failed("engine failed".into()),
            ],
        ] {
            let (tx, rx) = mpsc::channel();
            for item in items {
                tx.send(item).unwrap();
            }
            drop(tx);
            let meta = AudioFormatMeta {
                sample_rate: 8000,
                channels: 1,
                bits_per_sample: 16,
            };
            assert!(collect_speech(ChunkStream::new(meta, rx)).is_err());
        }
    }

    #[test]
    fn spawn_stream_delivers_items_errors_and_closes() {
        let ok_stream = spawn_stream(pcm_meta(), |sink| async move {
            assert!(sink.send(ChunkItem::Pcm(vec![1, 2])));
            assert!(sink.send(ChunkItem::Pcm(vec![3])));
            Ok(())
        });
        assert_eq!(ok_stream.recv(), Some(ChunkItem::Pcm(vec![1, 2])));
        assert_eq!(ok_stream.recv(), Some(ChunkItem::Pcm(vec![3])));
        assert_eq!(ok_stream.recv(), None);
        assert_eq!(ok_stream.recv_timeout(Duration::ZERO), Ok(None));

        let err_stream = spawn_stream(pcm_meta(), |sink| async move {
            assert!(sink.send(ChunkItem::Pcm(vec![7])));
            Err(TtsError::Http("boom".into()))
        });
        assert_eq!(err_stream.recv(), Some(ChunkItem::Pcm(vec![7])));
        assert_eq!(
            err_stream.recv(),
            Some(ChunkItem::Failed("HTTP error: boom".into()))
        );
        assert_eq!(err_stream.recv(), None);
    }

    #[test]
    fn spawn_stream_stops_producer_once_consumer_drops() {
        let (done_tx, done_rx) = mpsc::channel();
        let stream = spawn_stream(pcm_meta(), move |sink| async move {
            while sink.send(ChunkItem::Pcm(vec![0])) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let _ = done_tx.send(());
            Ok(())
        });
        assert!(stream.recv().is_some());
        drop(stream);
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("producer must stop pulling once the consumer is gone");
    }
}
