from cs61a_gui.runner import parse_ok_output


def test_parses_passed_output():
    result = parse_ok_output(
        "Test summary\n    3 test cases passed! No cases failed.\n", 0
    )
    assert result["status"] == "passed"
    assert result["passed"] == 3


def test_parses_failure_output():
    result = parse_ok_output(
        """Doctests for square
>>> square(2)
3
# Error: expected
#     4
# but got
#     3
Test summary
    0 test cases passed before encountering first failed test case
""",
        0,
    )
    assert result["status"] == "failed"
    assert result["details"]
    assert result["details"][0]["expected"] == "4"
    assert result["details"][0]["actual"] == "3"
