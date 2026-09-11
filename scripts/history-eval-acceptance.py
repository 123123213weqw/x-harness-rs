"""Independent, deliberately narrow acceptance for retry_ms source (stdin JSON).

Not a general Python sandbox. Only a tiny expression/branch AST is accepted;
the caller must additionally enforce process time/resource limits.
"""
import ast
import json
import sys


def check(source, base, cap, ceiling):
    tree = ast.parse(source)
    allowed = (
        ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return,
        ast.If, ast.Raise, ast.Call, ast.Name, ast.Load, ast.Constant,
        ast.Compare, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq,
        ast.BinOp, ast.Mult, ast.Add, ast.Sub, ast.Pow, ast.UnaryOp,
        ast.USub, ast.UAdd, ast.IfExp,
    )
    if len(source) > 8192 or len(list(ast.walk(tree))) > 250:
        raise ValueError("source too large")
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise ValueError("unsupported AST: " + type(node).__name__)
        if isinstance(node, ast.Name) and node.id not in {"attempt", "min", "max", "ValueError"}:
            raise ValueError("unsupported name")
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, str)) or len(str(node.value)) > 100:
                raise ValueError("unsupported literal")
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in {"min", "max", "ValueError"}):
            raise ValueError("unsupported call")
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise ValueError("exactly one function required")
    fn = tree.body[0]
    if fn.name != "retry_ms" or fn.decorator_list or fn.returns or fn.args.defaults or fn.args.kw_defaults or fn.args.vararg or fn.args.kwarg or fn.args.kwonlyargs or fn.args.posonlyargs or len(fn.args.args) != 1 or fn.args.args[0].arg != "attempt" or fn.args.args[0].annotation:
        raise ValueError("expected def retry_ms(attempt)")
    scope = {"__builtins__": {"min": min, "max": max, "ValueError": ValueError}}
    exec(compile(tree, "<candidate>", "exec"), scope)
    passed = 0
    for attempt in [-10, -1, 0, 1, 2, 3, 4, 7, 8, 20, 100]:
        try:
            actual = scope["retry_ms"](attempt)
            good = attempt >= 0 and actual == min(ceiling, base * 2 ** min(attempt, cap))
        except ValueError:
            good = attempt < 0
        passed += int(good)
    return {"passed": passed, "total": 11, "ok": passed == 11}


if __name__ == "__main__":
    if sys.platform == "linux":
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
    if sys.argv[1:] == ["--self-test"]:
        assert check("def retry_ms(attempt):\n if attempt < 0: raise ValueError('negative')\n return min(9000, 137 * 2 ** min(attempt, 7))\n", 137, 7, 9000)["ok"]
        assert not check("def retry_ms(attempt):\n return 0\n", 137, 7, 9000)["ok"]
        for bad in ["import os", "def retry_ms(attempt):\n return open('secret')", "def retry_ms(attempt):\n return attempt.__class__"]:
            try:
                check(bad, 137, 7, 9000)
                raise AssertionError("unsafe source accepted")
            except ValueError:
                pass
        print("5 acceptance self-tests passed")
    else:
        try:
            cfg = json.load(sys.stdin)
            print(json.dumps(check(**cfg)))
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}))
