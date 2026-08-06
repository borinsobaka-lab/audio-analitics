//! Minimal OggOpus file writer (RFC 7845): OpusHead + OpusTags headers,
//! then one audio packet per Ogg packet with granule position in 48 kHz samples.

use anyhow::Result;
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

const PRE_SKIP: u16 = 312; // samples @48k, typical for libopus

pub struct OggOpusWriter {
    writer: PacketWriter<'static, BufWriter<File>>,
    serial: u32,
    granule: u64,
    /// The most recent packet is held back so finish() can emit it with the
    /// EndStream flag: Opus forbids empty packets, so a stream cannot be
    /// terminated by appending an empty one — the LAST real packet must carry
    /// the end-of-stream marker itself.
    pending: Option<(Vec<u8>, u64)>,
}

impl OggOpusWriter {
    pub fn create(path: &Path, sample_rate: u32, serial: u32) -> Result<Self> {
        let file = BufWriter::new(File::create(path)?);
        let mut writer = PacketWriter::new(file);

        // OpusHead (19 bytes, mono, mapping family 0)
        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(1); // channel count
        head.extend_from_slice(&PRE_SKIP.to_le_bytes());
        head.extend_from_slice(&sample_rate.to_le_bytes()); // original input rate
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // mapping family
        writer.write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)?;

        // OpusTags
        let vendor = b"audio-analytics-recorder";
        let mut tags = Vec::new();
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes()); // no user comments
        writer.write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)?;

        Ok(Self {
            writer,
            serial,
            granule: PRE_SKIP as u64,
            pending: None,
        })
    }

    /// Write one encoded Opus packet covering `samples_48k` samples.
    pub fn write_packet(&mut self, packet: &[u8], samples_48k: u64) -> Result<()> {
        if let Some((data, granule)) = self.pending.take() {
            self.writer.write_packet(
                data,
                self.serial,
                PacketWriteEndInfo::NormalPacket,
                granule,
            )?;
        }
        self.granule += samples_48k;
        self.pending = Some((packet.to_vec(), self.granule));
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        if let Some((data, granule)) = self.pending.take() {
            self.writer.write_packet(
                data,
                self.serial,
                PacketWriteEndInfo::EndStream,
                granule,
            )?;
        }
        Ok(())
    }
}
