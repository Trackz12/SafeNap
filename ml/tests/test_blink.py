from features.blink import BlinkTracker, _js_round


def run(tracker, ears, start=0, dt=100):
    t = start
    for e in ears:
        tracker.update(e, t)
        t += dt
    return t - dt


def test_300ms_closure_is_one_blink_and_not_perclos():
    tr = BlinkTracker(0.25)
    end = run(tr, [0.35] * 5 + [0.10] * 3 + [0.35] * 5)
    assert tr.last_blink_at is not None
    assert tr.perclos(end) == 0.0          # segmento < 400 ms é ignorado no PERCLOS
    assert tr.blink_rate(end) >= 1


def test_long_closure_counts_for_perclos_but_is_not_a_blink():
    tr = BlinkTracker(0.25)
    end = run(tr, [0.35] * 5 + [0.10] * 12 + [0.35] * 5)
    assert tr.last_blink_at is None
    assert tr.perclos(end) > 0.0


def test_single_frame_spike_is_removed_by_median_filter():
    tr = BlinkTracker(0.25)
    end = run(tr, [0.35] * 5 + [0.05] + [0.35] * 5)
    assert tr.last_blink_at is None and tr.perclos(end) == 0.0


def test_face_lost_closes_the_open_segment():
    tr = BlinkTracker(0.25)
    run(tr, [0.35] * 3 + [0.10] * 8)
    tr.face_lost(2000)
    assert tr.perclos(2000) > 0.0          # o segmento aberto virou segmento fechado


def test_js_round_rounds_half_up_like_javascript():
    assert [_js_round(x) for x in (0.5, 1.5, 2.5, 2.4, 2.6)] == [1, 2, 3, 2, 3]
