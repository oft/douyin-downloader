from core.post_incremental import _classify_files


def test_shared_gallery_directory_is_read_once_and_changes_are_seen_next_time(tmp_path, monkeypatch):
    rows = {}
    for key in ['1', '2']:
        for index in [1, 2]:
            (tmp_path / ('{}_{}.jpg'.format(key, index))).write_bytes(b'image')
        rows[key] = {'aweme_id': key, 'aweme_type': 'gallery', 'image_count': 2,
                     'file_path': '{}_1.jpg'.format(key)}
    calls = []
    original = type(tmp_path).iterdir
    def list_directory(directory):
        calls.append(directory)
        return original(directory)
    monkeypatch.setattr(type(tmp_path), 'iterdir', list_directory)
    items = [{'aweme_id': '1'}, {'aweme_id': '2'}]
    assert _classify_files(rows, items, tmp_path, {})[0] == {'1', '2'}
    assert len(calls) == 1
    (tmp_path / '2_2.jpg').unlink()
    assert _classify_files(rows, items, tmp_path, {})[0] == {'1'}
    assert len(calls) == 2


def test_paths_and_symbolic_links_outside_root_are_never_saved_evidence(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    outside = tmp_path / 'outside.mp4'
    outside.write_bytes(b'outside')
    (root / 'linked.mp4').symlink_to(outside)
    rows = {'1': {'file_path': '../outside.mp4', 'aweme_type': 'video'},
            '2': {'file_path': 'linked.mp4', 'aweme_type': 'video'}}
    assert _classify_files(rows, [{'aweme_id': '1'}, {'aweme_id': '2'}], root, {})[0] == set()
