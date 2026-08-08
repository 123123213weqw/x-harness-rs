//! Pure bounded selection policy; no COM objects or operating-system calls.
#![cfg_attr(not(windows), allow(dead_code))]
use xharness_computer::Region;

pub fn intersection(a: Region, b: Region) -> Option<Region> {
    if ![a, b].iter().all(|r| {
        [r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height]
            .iter()
            .all(|v| v.is_finite())
            && r.width > 0.0
            && r.height > 0.0
    }) {
        return None;
    }
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    (right > x && bottom > y).then_some(Region {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}
#[derive(Clone, Debug)]
pub struct Metadata {
    pub parent: Option<usize>,
    pub depth: usize,
    pub bounds: Option<Region>,
    pub visible: bool,
    pub focused: bool,
    pub meaningful: bool,
}
impl Metadata {
    pub fn in_scope(&self, viewport: Option<Region>) -> bool {
        self.visible
            && self
                .bounds
                .zip(viewport)
                .is_some_and(|(a, b)| intersection(a, b).is_some())
    }
    /// Breadth-first within each visibility tier. Invisible or empty wrappers
    /// are deferred, not pruned: they can contain visible children.
    pub fn priority(&self, viewport: Option<Region>, index: usize) -> (u8, usize, usize) {
        let tier = if self.in_scope(viewport) {
            0
        } else if self
            .bounds
            .is_none_or(|r| r.width <= 0.0 || r.height <= 0.0)
        {
            1
        } else {
            2
        };
        (tier, self.depth, index)
    }
}
pub struct Selection {
    pub indices: Vec<usize>,
    pub eligible: usize,
    pub omitted: usize,
}
/// A node is admitted together with its ancestor closure, or not at all.
/// Parent indices must precede children; malformed ancestry fails closed.
pub fn select(nodes: &[Metadata], viewport: Option<Region>, limit: usize) -> Selection {
    let mut ranked: Vec<_> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.in_scope(viewport) && (n.meaningful || n.focused))
        .map(|(i, n)| ((!n.focused, n.depth, i), i))
        .collect();
    ranked.sort_unstable_by_key(|(key, _)| *key);
    let eligible = ranked.len();
    let mut selected = vec![false; nodes.len()];
    let mut count = 0;
    let mut admitted = 0;
    for (_, i) in ranked {
        let mut closure = vec![];
        let mut cursor = Some(i);
        let mut valid = true;
        while let Some(index) = cursor {
            if selected[index] {
                break;
            }
            closure.push(index);
            cursor = nodes[index].parent;
            if cursor.is_some_and(|p| p >= index) {
                valid = false;
                break;
            }
        }
        if valid && count + closure.len() <= limit {
            for index in closure {
                selected[index] = true;
                count += 1;
            }
            admitted += 1;
        }
    }
    Selection {
        indices: selected
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.then_some(i))
            .collect(),
        eligible,
        omitted: eligible - admitted,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn region(x: f64, y: f64, w: f64, h: f64) -> Region {
        Region {
            x,
            y,
            width: w,
            height: h,
        }
    }
    fn node(parent: Option<usize>, bounds: Option<Region>, visible: bool) -> Metadata {
        Metadata {
            parent,
            depth: usize::from(parent.is_some()),
            bounds,
            visible,
            focused: false,
            meaningful: true,
        }
    }
    #[test]
    fn geometry_handles_negative_origins_and_rejects_invalid_rectangles() {
        let a = region(-100.0, -30.0, 200.0, 100.0);
        assert_eq!(
            intersection(a, region(0.0, 0.0, 50.0, 20.0)),
            Some(region(0.0, 0.0, 50.0, 20.0))
        );
        for b in [
            region(100.0, 0.0, 1.0, 1.0),
            region(0.0, 0.0, 0.0, 1.0),
            region(f64::NAN, 0.0, 1.0, 1.0),
            region(f64::MAX, 0.0, f64::MAX, 1.0),
        ] {
            assert!(intersection(a, b).is_none());
        }
    }
    #[test]
    fn long_offscreen_sidebar_cannot_spend_output_budget() {
        let viewport = Some(region(0.0, 0.0, 100.0, 100.0));
        let mut nodes = vec![node(None, viewport, true)];
        nodes[0].meaningful = false;
        for _ in 0..500 {
            nodes.push(node(Some(0), Some(region(200.0, 200.0, 10.0, 10.0)), false));
        }
        nodes.push(node(Some(0), Some(region(10.0, 10.0, 10.0, 10.0)), true));
        let result = select(&nodes, viewport, 3);
        assert_eq!(result.indices, vec![0, 501]);
        assert_eq!(result.omitted, 0);
    }
    #[test]
    fn region_filters_visible_controls_but_preserves_ancestors() {
        let nodes = vec![
            node(None, Some(region(0.0, 0.0, 200.0, 200.0)), true),
            node(Some(0), Some(region(0.0, 0.0, 10.0, 10.0)), true),
            node(Some(0), Some(region(100.0, 100.0, 10.0, 10.0)), true),
        ];
        assert_eq!(
            select(&nodes, Some(region(90.0, 90.0, 30.0, 30.0)), 3).indices,
            vec![0, 2]
        );
    }
    #[test]
    fn invisible_wrapper_is_not_a_pruning_signal() {
        let viewport = Some(region(0.0, 0.0, 100.0, 100.0));
        let nodes = vec![
            node(None, viewport, false),
            node(Some(0), None, false),
            node(Some(1), Some(region(20.0, 20.0, 10.0, 10.0)), true),
        ];
        assert_eq!(select(&nodes, viewport, 3).indices, vec![0, 1, 2]);
        assert_eq!(select(&nodes, viewport, 2).omitted, 1);
    }
    #[test]
    fn focused_node_wins_and_all_limits_preserve_parent_closure() {
        let viewport = Some(region(0.0, 0.0, 100.0, 100.0));
        let mut nodes = vec![
            node(None, viewport, true),
            node(Some(0), viewport, true),
            node(Some(0), viewport, true),
        ];
        nodes[2].focused = true;
        for limit in 0..=3 {
            let s = select(&nodes, viewport, limit);
            assert!(s.indices.len() <= limit);
            for i in &s.indices {
                if let Some(p) = nodes[*i].parent {
                    assert!(s.indices.contains(&p));
                }
            }
        }
        assert_eq!(select(&nodes, viewport, 2).indices, vec![0, 2]);
    }
    #[test]
    fn out_of_scope_focus_and_invalid_ancestry_cannot_leak() {
        let viewport = Some(region(0.0, 0.0, 100.0, 100.0));
        let mut nodes = vec![
            node(Some(0), viewport, true),
            node(None, Some(region(200.0, 200.0, 10.0, 10.0)), true),
        ];
        nodes[1].focused = true;
        assert!(select(&nodes, viewport, 5).indices.is_empty());
        assert!(select(&nodes, None, 5).indices.is_empty());
    }
    #[test]
    fn traversal_priority_is_breadth_first_not_sidebar_depth_first() {
        let viewport = Some(region(0.0, 0.0, 100.0, 100.0));
        let mut deep = node(None, viewport, true);
        deep.depth = 12;
        let mut shallow = deep.clone();
        shallow.depth = 2;
        let unknown = node(None, None, false);
        let offscreen = node(None, Some(region(200.0, 200.0, 10.0, 10.0)), false);
        assert!(shallow.priority(viewport, 99) < deep.priority(viewport, 0));
        assert!(deep.priority(viewport, 99) < unknown.priority(viewport, 0));
        assert!(unknown.priority(viewport, 99) < offscreen.priority(viewport, 0));
    }
}
