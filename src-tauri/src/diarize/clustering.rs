//! Numerical clustering primitives used by batch speaker diarization.
//!
//! Pure-Rust port of the numpy implementation in
//! `src-python/services/batch_diarizer.py`, which was itself verified to be
//! byte-for-byte equivalent to `scipy.spatial.distance.pdist(metric="cosine")`
//! + `scipy.cluster.hierarchy.linkage(method="average")` +
//! `scipy.cluster.hierarchy.fcluster(criterion="distance")` on 192 real
//! meeting embeddings across 4 thresholds.
//!
//! No BLAS/LAPACK, no `ndarray`: the matrices here are `n x dim` with `n` in
//! the hundreds (2-second windows of one meeting), so flat `Vec<f32>`/`Vec<f64>`
//! row-major storage is both simpler and fast enough. This keeps the module
//! dependency-free and portable to every Tauri target.

/// Pairwise cosine distance matrix, mirroring
/// `scipy.spatial.distance.pdist(metric="cosine")` expanded to a square matrix.
///
/// scipy defines cosine distance as `1 - u·v/(|u||v|)`. Rows are normalised
/// defensively so un-normalised input behaves identically to scipy. The result
/// is clipped to `[0, 2]` and has a zeroed diagonal (pdist never emits
/// self-distances).
pub fn cosine_distance_matrix(matrix: &[Vec<f32>]) -> Vec<Vec<f64>> {
    let n = matrix.len();
    if n == 0 {
        return Vec::new();
    }
    let dim = matrix[0].len();

    // Row-normalise; a zero row maps to norm 1.0 so it stays all-zero
    // (matching `np.where(norms == 0, 1.0, norms)`).
    let mut unit: Vec<Vec<f64>> = Vec::with_capacity(n);
    for row in matrix.iter() {
        let mut norm = 0.0f64;
        for &v in row.iter() {
            norm += (v as f64) * (v as f64);
        }
        norm = norm.sqrt();
        if norm == 0.0 {
            norm = 1.0;
        }
        unit.push(row.iter().map(|&v| v as f64 / norm).collect());
    }

    let mut d = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        let (head, tail) = d.split_at_mut(i + 1);
        let row_i = &mut head[i];
        for j in (i + 1)..n {
            let mut dot = 0.0f64;
            let a = &unit[i];
            let b = &unit[j];
            for k in 0..dim {
                dot += a[k] * b[k];
            }
            let dist = (1.0 - dot).clamp(0.0, 2.0);
            row_i[j] = dist;
            tail[j - i - 1][i] = dist;
        }
    }
    d
}

/// One row of a scipy-style linkage matrix: `[cluster_a, cluster_b, distance, size]`.
///
/// Cluster labels follow scipy's convention: original observations are `0..n-1`
/// and merge `i` creates cluster `n+i`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Merge {
    pub a: usize,
    pub b: usize,
    pub distance: f64,
    pub size: usize,
}

/// Agglomerative average-linkage merge sequence (scipy `linkage(method='average')`).
///
/// Returns `n-1` merges. Uses the straightforward "pick the global minimum each
/// step" rule rather than a nearest-neighbour chain, because the latter changes
/// tie ordering and would break parity with scipy. O(n^3) worst case, but `n` is
/// the number of 2s windows in one meeting (hundreds), and this runs once per
/// upload.
pub fn average_linkage(dist: &[Vec<f64>]) -> Vec<Merge> {
    let n = dist.len();
    if n < 2 {
        return Vec::new();
    }

    // Working copy of the distance matrix between active clusters (f64 for the
    // same numerical stability the numpy version gets from `astype(np.float64)`).
    let mut d: Vec<Vec<f64>> = dist.to_vec();
    let mut sizes: Vec<usize> = vec![1; n];
    let mut active: Vec<bool> = vec![true; n];
    let mut merges: Vec<Merge> = Vec::with_capacity(n - 1);

    for _step in 0..(n - 1) {
        // Mask inactive rows/cols AND the diagonal: scipy only merges distinct
        // clusters, and a zeroed diagonal would otherwise always win argmin.
        let mut best = f64::INFINITY;
        let mut bi = usize::MAX;
        let mut bj = usize::MAX;
        for i in 0..n {
            if !active[i] {
                continue;
            }
            for j in (i + 1)..n {
                if !active[j] {
                    continue;
                }
                let v = d[i][j];
                if v < best {
                    best = v;
                    bi = i;
                    bj = j;
                }
            }
        }
        // Should not happen while >=2 clusters are active, but stay total.
        if bi == usize::MAX {
            break;
        }
        let merge_dist = best;
        merges.push(Merge {
            a: bi,
            b: bj,
            distance: merge_dist,
            size: sizes[bi] + sizes[bj],
        });

        // Lance-Williams update for average linkage (UPGMA):
        //   d(new, k) = (n_i*d(i,k) + n_j*d(j,k)) / (n_i + n_j)
        let ni = sizes[bi] as f64;
        let nj = sizes[bj] as f64;
        let total = ni + nj;
        for k in 0..n {
            if k == bi || k == bj {
                continue;
            }
            let new_d = (ni * d[bi][k] + nj * d[bj][k]) / total;
            d[bi][k] = new_d;
            d[k][bi] = new_d;
        }
        d[bi][bi] = 0.0;
        sizes[bi] = sizes[bi] + sizes[bj];
        active[bj] = false;
        // Park inactive j behind +inf in both directions, matching numpy.
        for k in 0..n {
            d[bj][k] = f64::INFINITY;
            d[k][bj] = f64::INFINITY;
        }
    }

    merges
}

/// Flat clusters from a linkage matrix (scipy `fcluster(criterion='distance')`).
///
/// scipy's rule: cut at `threshold` — observations joined by a merge whose
/// distance is `<= threshold` belong to the same flat cluster. Labels are
/// returned 1..k in first-discovery order (callers renumber by appearance).
pub fn fcluster_distance(merges: &[Merge], n: usize, threshold: f64) -> Vec<usize> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![1];
    }

    // Union-Find over observations, applying every merge under the threshold.
    let mut parent: Vec<usize> = (0..n).collect();

    fn find(parent: &mut Vec<usize>, x: usize) -> usize {
        let mut root = x;
        while parent[root] != root {
            root = parent[root];
        }
        // Path compression, matching the numpy helper.
        let mut cur = x;
        while parent[cur] != root {
            let next = parent[cur];
            parent[cur] = root;
            cur = next;
        }
        root
    }

    for m in merges {
        if m.distance <= threshold {
            let ra = find(&mut parent, m.a);
            let rb = find(&mut parent, m.b);
            if ra != rb {
                // Attach the larger root under the smaller one, as numpy does.
                parent[ra.max(rb)] = ra.min(rb);
            }
        }
    }

    // Renumber roots to contiguous 1..k (matching fcluster's return type).
    let mut labels = vec![0usize; n];
    let mut next_label = 0usize;
    let mut root_to_label: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        let label = *root_to_label.entry(r).or_insert_with(|| {
            next_label += 1;
            next_label
        });
        labels[i] = label;
    }
    labels
}

/// Property tests mirroring `src-python/tests/test_diarizer_clustering.py`.
#[cfg(test)]
#[path = "clustering_tests.rs"]
mod tests;

/// Clusters smaller than this many windows (2 s each → < 6 s of speech) are
/// not treated as a person: a cough, laugh or crosstalk window embeds
/// erratically and becomes its own singleton cluster. Without a speaker cap
/// those singletons surfaced as dozens of phantom speakers (139 on an
/// 8-speaker podcast), so they are folded into the nearest real cluster.
pub const MIN_CLUSTER_WINDOWS: usize = 3;

/// Reassign members of clusters smaller than `min_size` to the closest (by
/// centroid cosine similarity) cluster that is at least `min_size`. No-op when
/// no cluster is large enough (very short audio).
pub fn absorb_tiny_clusters(embeddings: &[Vec<f32>], labels: &mut [usize], min_size: usize) {
    use std::collections::HashMap;
    let mut members: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, &l) in labels.iter().enumerate() {
        members.entry(l).or_default().push(i);
    }
    let centroid = |idx: &[usize]| -> Vec<f64> {
        let dim = embeddings[idx[0]].len();
        let mut c = vec![0f64; dim];
        for &i in idx {
            for (a, &x) in c.iter_mut().zip(&embeddings[i]) {
                *a += x as f64;
            }
        }
        let n = c.iter().map(|x| x * x).sum::<f64>().sqrt().max(1e-12);
        c.iter().map(|x| x / n).collect()
    };
    let big: Vec<(usize, Vec<f64>)> = members
        .iter()
        .filter(|(_, m)| m.len() >= min_size)
        .map(|(&l, m)| (l, centroid(m)))
        .collect();
    if big.is_empty() {
        return;
    }
    for (_, m) in members.iter().filter(|(_, m)| m.len() < min_size) {
        for &i in m {
            let e = &embeddings[i];
            let en = e.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().sqrt().max(1e-12);
            let best = big
                .iter()
                .map(|(l, c)| (*l, c.iter().zip(e).map(|(a, &b)| a * b as f64).sum::<f64>() / en))
                .fold((big[0].0, f64::MIN), |acc, x| if x.1 > acc.1 { x } else { acc });
            labels[i] = best.0;
        }
    }
}

/// Cluster embeddings into speaker IDs, mirroring
/// `batch_diarizer.cluster_speakers`.
///
/// Returns `{chunk_idx: speaker_id}` where speaker IDs are assigned in temporal
/// order: whoever speaks first becomes speaker 0, the next new voice speaker 1,
/// and so on. The number of speakers is whatever the distance threshold
/// yields — there is deliberately no cap (a cap folded every extra person
/// onto the last id, mislabelling large meetings).
pub fn cluster_speakers(
    items: &[(usize, Vec<f32>)],
    distance_threshold: f64,
) -> std::collections::HashMap<usize, usize> {
    let mut out = std::collections::HashMap::new();
    if items.is_empty() {
        return out;
    }
    if items.len() == 1 {
        out.insert(items[0].0, 0);
        return out;
    }

    let matrix: Vec<Vec<f32>> = items.iter().map(|(_, e)| e.clone()).collect();
    let dist = cosine_distance_matrix(&matrix);
    let merges = average_linkage(&dist);
    let mut raw_labels = fcluster_distance(&merges, items.len(), distance_threshold);
    absorb_tiny_clusters(&matrix, &mut raw_labels, MIN_CLUSTER_WINDOWS);

    let mut seen: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for (pos, (chunk_idx, _)) in items.iter().enumerate() {
        let raw = raw_labels[pos];
        let next = seen.len();
        let speaker_id = *seen.entry(raw).or_insert(next);
        out.insert(*chunk_idx, speaker_id);
    }
    out
}
