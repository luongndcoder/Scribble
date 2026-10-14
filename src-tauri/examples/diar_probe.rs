//! Isolate the diarizer path on real audio: does it identify at all?
use std::path::Path;
use voicescribe_lib::diarize::{self, embedding, SpeakerProfile};

fn cos(a:&[f32],b:&[f32])->f32{ a.iter().zip(b).map(|(x,y)|x*y).sum() }

fn main() {
    let model = diarize::default_model_path().expect("no model");
    let mut r = hound::WavReader::open("/tmp/sale_campaign.wav").unwrap();
    let pcm: Vec<f32> = r.samples::<i16>().filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0).skip(16000*10).take(32000).collect();
    let emb = embedding::embed_samples(&model, &pcm, 2);
    println!("embed t=10s: {:?}", emb.as_ref().map(|e| (e.len(),
        e.iter().map(|x|x*x).sum::<f32>().sqrt())));
    let Some(emb) = emb else { println!("EMBED FAILED"); return };

    let mut r2 = hound::WavReader::open("/tmp/sale_campaign.wav").unwrap();
    let p2: Vec<f32> = r2.samples::<i16>().filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0).skip(16000*30).take(32000).collect();
    let e2 = embedding::embed_samples(&model, &p2, 2).unwrap();
    println!("window@10s <-> window@30s sim: {:.4}", cos(&emb, &e2));

    let prof = SpeakerProfile { name: "A".into(), embedding: emb.clone() };
    let id = diarize::identify_speaker_from_samples(&model, &pcm, 16000, &[prof]);
    println!("self-match (expect A sim~1.0): {:?}", id.map(|i| (i.name, i.similarity)));
    let none = diarize::identify_speaker_from_samples(&model, &p2, 16000, &[SpeakerProfile{
        name: "A".into(), embedding: emb.clone()}]);
    println!("cross-match window@30s vs profile@10s: {:?}", none.map(|i| (i.name, i.similarity)));
}
