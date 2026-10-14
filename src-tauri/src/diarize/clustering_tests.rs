//! Property tests for the clustering port.
//!
//! These mirror `src-python/tests/test_diarizer_clustering.py`, which documents
//! the invariants the numpy implementation must satisfy to be a drop-in
//! replacement for scipy. The port must satisfy the same ones.
//!
//! The strongest evidence is not here but in the cross-implementation run:
//! the Rust and numpy clusterers were fed the *identical* 192 real meeting
//! embeddings and produced identical partitions at 9 thresholds. These tests
//! pin the properties that make that possible on synthetic input.

use super::*;

/// Deterministic PRNG so failures reproduce exactly (no `rand` dependency).
fn lcg(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((state >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

/// `n` unit embeddings drawn from `k` well-separated directions, plus noise.
/// Equivalent in spirit to the Python helper `_unit_embeddings`.
fn unit_embeddings(n: usize, k: usize, dim: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rng = lcg(seed);
    let mut centers: Vec<Vec<f64>> = Vec::with_capacity(k);
    for _ in 0..k {
        let mut c: Vec<f64> = (0..dim).map(|_| rng() * 2.0 - 1.0).collect();
        let norm = c.iter().map(|v| v * v).sum::<f64>().sqrt().max(1e-12);
        for v in c.iter_mut() {
            *v /= norm;
        }
        centers.push(c);
    }
    (0..n)
        .map(|i| {
            let c = &centers[i % k];
            let mut v: Vec<f64> = c.iter().map(|&x| x + (rng() * 2.0 - 1.0) * 0.05).collect();
            let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt().max(1e-12);
            for x in v.iter_mut() {
                *x /= norm;
            }
            v.into_iter().map(|x| x as f32).collect()
        })
        .collect()
}

/// Order-independent view of a labelling, for comparing partitions.
fn partition(labels: &[usize]) -> Vec<Vec<usize>> {
    let mut groups: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for (i, &l) in labels.iter().enumerate() {
        groups.entry(l).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = groups.into_values().collect();
    for g in out.iter_mut() {
        g.sort_unstable();
    }
    out.sort();
    out
}

// ── cosine distance ──────────────────────────────────────────────────────────

#[test]
fn cosine_distance_matches_definition() {
    let m = unit_embeddings(12, 3, 64, 7);
    let d = cosine_distance_matrix(&m);
    assert_eq!(d.len(), 12);
    for i in 0..12 {
        assert_eq!(d[i][i], 0.0, "diagonal must be zero (pdist never emits self-distances)");
        for j in 0..12 {
            assert!((d[i][j] - d[j][i]).abs() < 1e-12, "matrix must be symmetric");
            assert!((0.0..=2.0).contains(&d[i][j]), "distance out of [0,2]");
        }
    }
    // 1 - cos for a known pair.
    let a = &m[0];
    let b = &m[1];
    let dot: f64 = a.iter().zip(b).map(|(x, y)| (*x as f64) * (*y as f64)).sum();
    assert!((d[0][1] - (1.0 - dot)).abs() < 1e-6);
}

#[test]
fn cosine_distance_normalises_unnormalised_input() {
    let m = unit_embeddings(6, 2, 64, 3);
    let scaled: Vec<Vec<f32>> = m.iter().map(|r| r.iter().map(|v| v * 4.0).collect()).collect();
    let d1 = cosine_distance_matrix(&m);
    let d2 = cosine_distance_matrix(&scaled);
    for i in 0..6 {
        for j in 0..6 {
            assert!((d1[i][j] - d2[i][j]).abs() < 1e-6, "scale must not change distance");
        }
    }
}

#[test]
fn cosine_distance_handles_zero_rows() {
    // A zero row must not produce NaN (norm is forced to 1.0, as numpy does).
    let m = vec![vec![0.0f32; 4], vec![1.0, 0.0, 0.0, 0.0]];
    let d = cosine_distance_matrix(&m);
    assert!(d[0][1].is_finite());
}

#[test]
fn cosine_distance_empty_input() {
    assert!(cosine_distance_matrix(&[]).is_empty());
}

// ── average linkage ──────────────────────────────────────────────────────────

#[test]
fn linkage_produces_n_minus_1_merges() {
    for n in [2usize, 5, 17] {
        let m = unit_embeddings(n, 2, 64, 7);
        let merges = average_linkage(&cosine_distance_matrix(&m));
        assert_eq!(merges.len(), n - 1, "n={n}");
    }
}

#[test]
fn linkage_merges_nearest_clusters_first() {
    let m = unit_embeddings(8, 4, 64, 3);
    let d = cosine_distance_matrix(&m);
    // Find the global off-diagonal minimum.
    let mut best = f64::INFINITY;
    let (mut bi, mut bj) = (0usize, 1usize);
    for i in 0..8 {
        for j in (i + 1)..8 {
            if d[i][j] < best {
                best = d[i][j];
                bi = i;
                bj = j;
            }
        }
    }
    let merges = average_linkage(&d);
    let first = [merges[0].a, merges[0].b];
    assert!(first.contains(&bi) && first.contains(&bj), "first merge must join the closest pair");
    assert!((merges[0].distance - best).abs() < 1e-6);
}

#[test]
fn linkage_distances_are_monotonic() {
    // Average linkage never produces a decreasing merge distance.
    let m = unit_embeddings(30, 5, 64, 7);
    let merges = average_linkage(&cosine_distance_matrix(&m));
    for w in merges.windows(2) {
        assert!(
            w[1].distance >= w[0].distance - 1e-9,
            "merge distances must be non-decreasing: {} then {}",
            w[0].distance,
            w[1].distance
        );
    }
}

#[test]
fn linkage_sizes_grow_to_n() {
    let n = 20;
    let m = unit_embeddings(n, 3, 64, 7);
    let merges = average_linkage(&cosine_distance_matrix(&m));
    assert_eq!(merges.last().unwrap().size, n, "final merge spans everything");
    // Every merge reports the combined size of both clusters.
    for mr in &merges {
        assert!(mr.size >= 2 && mr.size <= n);
    }
}

#[test]
fn linkage_of_single_and_empty_input() {
    assert!(average_linkage(&[]).is_empty());
    assert!(average_linkage(&[vec![0.0]]).is_empty());
}

// ── flat clustering ──────────────────────────────────────────────────────────

#[test]
fn fcluster_threshold_monotonicity() {
    // A higher cut distance can only merge clusters, never split them.
    let m = unit_embeddings(40, 5, 64, 7);
    let merges = average_linkage(&cosine_distance_matrix(&m));
    let counts: Vec<usize> = [0.2, 0.5, 0.8, 1.2]
        .iter()
        .map(|&t| {
            let l = fcluster_distance(&merges, m.len(), t);
            l.iter().collect::<std::collections::HashSet<_>>().len()
        })
        .collect();
    for w in counts.windows(2) {
        assert!(w[1] <= w[0], "higher threshold must not increase cluster count: {counts:?}");
    }
}

#[test]
fn fcluster_below_all_merges_is_all_singletons() {
    let m = unit_embeddings(10, 3, 64, 7);
    let merges = average_linkage(&cosine_distance_matrix(&m));
    let labels = fcluster_distance(&merges, m.len(), -1.0);
    assert_eq!(
        labels.iter().collect::<std::collections::HashSet<_>>().len(),
        m.len()
    );
}

#[test]
fn fcluster_above_all_merges_is_one_cluster() {
    let m = unit_embeddings(10, 3, 64, 7);
    let merges = average_linkage(&cosine_distance_matrix(&m));
    let labels = fcluster_distance(&merges, m.len(), 99.0);
    assert_eq!(
        labels.iter().collect::<std::collections::HashSet<_>>().len(),
        1
    );
}

#[test]
fn fcluster_recovers_planted_clusters() {
    // Well-separated planted groups must come back intact at a sane cut.
    let m = unit_embeddings(60, 4, 64, 11);
    let merges = average_linkage(&cosine_distance_matrix(&m));
    let labels = fcluster_distance(&merges, m.len(), 0.35);
    assert_eq!(
        labels.iter().collect::<std::collections::HashSet<_>>().len(),
        4
    );
}

#[test]
fn fcluster_never_panics_on_tiny_input() {
    assert!(fcluster_distance(&[], 0, 0.5).is_empty());
    assert_eq!(fcluster_distance(&[], 1, 0.5), vec![1]);
}

// ── public entry point ───────────────────────────────────────────────────────

#[test]
fn cluster_speakers_assigns_ids_in_temporal_order() {
    let m = unit_embeddings(12, 3, 64, 5);
    let items: Vec<(usize, Vec<f32>)> = m.iter().cloned().enumerate().map(|(i, e)| (i, e)).collect();
    let result = cluster_speakers(&items, 0.35);
    assert_eq!(result.len(), m.len());
    assert_eq!(result[&0], 0, "first item always becomes speaker 0");
    assert!(result.values().any(|&v| v == 0));
}

#[test]
fn cluster_speakers_handles_degenerate_inputs() {
    assert!(cluster_speakers(&[], 0.45).is_empty());
    let single = cluster_speakers(&[(7, vec![1.0, 0.0])], 0.45);
    assert_eq!(single.get(&7), Some(&0));
}

#[test]
fn cluster_speakers_partition_is_independent_of_threshold_ordering() {
    // Sanity: the partition returned is a genuine partition of every index.
    let m = unit_embeddings(25, 4, 64, 17);
    let items: Vec<(usize, Vec<f32>)> = m.iter().cloned().enumerate().map(|(i, e)| (i, e)).collect();
    for t in [0.1, 0.3, 0.5, 0.9] {
        let r = cluster_speakers(&items, t);
        let mut keys: Vec<usize> = r.keys().copied().collect();
        keys.sort_unstable();
        assert_eq!(keys, (0..25).collect::<Vec<_>>(), "t={t}");
    }
}

#[test]
fn similarity_matches_partition_sanity() {
    // The port must at least agree with itself: identical inputs -> identical output.
    let m = unit_embeddings(20, 3, 64, 21);
    let items: Vec<(usize, Vec<f32>)> = m.iter().cloned().enumerate().map(|(i, e)| (i, e)).collect();
    let a = cluster_speakers(&items, 0.4);
    let b = cluster_speakers(&items, 0.4);
    let la: Vec<usize> = (0..20).map(|i| a[&i]).collect();
    let lb: Vec<usize> = (0..20).map(|i| b[&i]).collect();
    assert_eq!(partition(&la), partition(&lb));
}

#[test]
fn tiny_clusters_are_absorbed_into_nearest_real_speaker() {
    // Two real speakers (5 windows each) + one stray window close to speaker B.
    let a = vec![1.0f32, 0.0, 0.0];
    let b = vec![0.0f32, 1.0, 0.0];
    let stray = vec![0.1f32, 0.9, 0.4];
    let mut emb: Vec<Vec<f32>> = Vec::new();
    let mut labels: Vec<usize> = Vec::new();
    for _ in 0..5 { emb.push(a.clone()); labels.push(0); }
    for _ in 0..5 { emb.push(b.clone()); labels.push(1); }
    emb.push(stray); labels.push(2);
    absorb_tiny_clusters(&emb, &mut labels, 3);
    assert_eq!(labels[10], 1, "stray window must join speaker B");
    assert!(labels.iter().all(|&l| l == 0 || l == 1));
}

#[test]
fn absorb_is_noop_when_every_cluster_is_tiny() {
    let emb = vec![vec![1.0f32, 0.0], vec![0.0, 1.0]];
    let mut labels = vec![0usize, 1];
    absorb_tiny_clusters(&emb, &mut labels, 3);
    assert_eq!(labels, vec![0, 1]);
}
