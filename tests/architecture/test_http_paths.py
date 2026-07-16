from platform_kit.http_paths import normalize_route_path


def test_normalize_collapses_ids_and_phones() -> None:
    assert (
        normalize_route_path("/ops/contacts/+573001234567/history")
        == "/ops/contacts/{id}/history"
    )
    assert (
        normalize_route_path("/ops/reports/semanal")
        == "/ops/reports/semanal"
    )
    assert (
        normalize_route_path("/ops/documents/a1b2c3d4e5f60718293a4b5c6d7e8f90")
        == "/ops/documents/{id}"
    )
    assert (
        normalize_route_path("/ops/crm/550e8400-e29b-41d4-a716-446655440000")
        == "/ops/crm/{id}"
    )


def test_normalize_bounds_length() -> None:
    crazy = "/" + "/".join(f"seg{i}" for i in range(40))
    out = normalize_route_path(crazy)
    assert out.count("/") <= 12
    assert len(out) <= 120
