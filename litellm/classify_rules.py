"""Classification rules shared by the LiteLLM hook and the Claude Code gateway: the classifier prompts and the local keyword heuristic.
Pure Python (no LiteLLM import)."""

CHECKPOINT_PROMPT = (
    "Você avalia um agente de código no meio de uma tarefa. Dado o pedido original e os últimos passos, classifique os PRÓXIMOS passos. "
    'Responda só JSON: {"task": um de qa|explain_code|codegen|feature|frontend|refactor|debug|test_review|architecture|data|doc_tech|writing|'
    'research_long|mechanical, "complexity": 1-5, "risk": true|false, "long_output": true|false}. '
    "mechanical = passo já decidido (aplicar edições conhecidas, ler arquivos, rodar comandos). "
    "1 = trivial; 3 = mudança em várias etapas numa área; 5 = desenho transversal, debug difícil ou falhas repetidas."
)
CLASSIFIER_PROMPT = (
    "Classifique o pedido para um assistente de produto e código. "
    'Responda só JSON: {"task": um de qa|explain_code|codegen|feature|frontend|refactor|debug|test_review|architecture|data|doc_tech|writing|'
    'research_long, "complexity": 1-5, '
    '"risk": true se envolver produção, migração de banco, pagamentos, segurança ou dados pessoais, '
    '"long_output": true se pedir texto longo}. '
    "1 = trivial; 3 = mudança em várias etapas numa área; 5 = desenho transversal, debug difícil ou refatoração grande."
)

HEURISTIC_WORDS = (
    ("debug", ("bug", "error", "traceback", "fails", "failing", "erro", "falha", "exception", "não funciona")),
    ("test_review", ("test", "teste", "review", "revis")),
    ("refactor", ("refactor", "refator", "rename", "cleanup", "migrat", "migr")),
    ("architecture", ("architecture", "arquitetura", "design", "planej", "plano técnico", "adr")),
    ("frontend", ("css", "layout", "component", "componente", "tela", "ui ", "botão", "button")),
    ("data", ("sql", "pandas", "query", "dataframe", "estatíst", "notebook")),
    ("doc_tech", ("readme", "spec", "prd", "user story", "documentação", "documentacao")),
    ("writing", ("e-mail", "email", "post", "pitch", "copy", "texto para")),
    ("feature", ("feature", "funcionalidade", "implement", "implemente")),
    ("codegen", ("create", "add ", "write", "crie", "função", "function", "script", "regex")),
    ("research_long", ("todos os arquivos", "all files", "repositório inteiro", "whole repo")),
)


def heuristic(text: str) -> dict:
    """Local, free classification (also used when no model may see the text)."""
    t = text.lower()
    task = "qa"
    for name, words in HEURISTIC_WORDS:
        if any(w in t for w in words):
            task = name
            break
    complexity = 1 if len(text) < 200 else 2 if len(text) < 800 else 3
    return {"task": task, "complexity": complexity, "risk": False, "long_output": False, "source": "heuristic"}


# ---------------------------------------------------------------- richer analysis for the Claude Code gateway (gateway/router.py)
# What the task REQUIRES, so each model's adequacy can be scored against it. The project card (if any) and the session state are
# appended to the text by the gateway.
_GW_FIELDS = (
    '{"task": one of qa|explain_code|codegen|feature|frontend|refactor|debug|test_review|architecture|data|doc_tech|writing|'
    'research_long%s, '
    '"complexity": 1-5 (1 trivial; 3 multi-step change in one area; 5 cross-cutting design, hard debugging, large refactor), '
    '"reasoning_depth": 1-5 (how many dependent inferences must be held at once; 1 lookup, 3 plan a change across a few files, '
    '5 subtle concurrency/security/algorithmic reasoning or diagnosing a non-obvious cause), '
    '"uncertainty": 0.0-1.0 (how unsure you are of this rating: vague or very short requests are uncertain), '
    '"scope": "small"|"medium"|"large" (files/modules the work touches), '
    '"tool_intensity": 0-3 (0 answer only, 1 read a few files, 2 edit and run commands, 3 long autonomous loop), '
    '"risk": true if production, data migration, payments, security, credentials or personal data are involved, '
    '"long_output": true if a long text/code output is expected}'
)
GATEWAY_CLASSIFIER_PROMPT = (
    "You rate a request sent to a coding agent so a router can pick the smallest model that will do it well. "
    "Rate what the task REQUIRES, not how long the message is. Answer with JSON only: " + _GW_FIELDS % ""
)
GATEWAY_CHECKPOINT_PROMPT = (
    "You rate the REMAINING work of a coding agent in the middle of a task, given the original request and its latest steps, "
    "so a router can keep, raise or lower the model. mechanical = the plan is decided and only known edits, reads or commands "
    "remain. Repeated failures or a cause not yet understood mean higher reasoning_depth. Answer with JSON only: "
    + _GW_FIELDS % "|mechanical"
)
SCOPES = ("small", "medium", "large")


def heuristic_rich(text: str) -> dict:
    """heuristic() plus the gateway's fields; a keyword guess, so it is marked uncertain."""
    h = heuristic(text)
    c = h["complexity"]
    return dict(h, reasoning_depth=c, uncertainty=0.8, scope="small" if c == 1 else "medium", tool_intensity=1)


def normalise_rich(out: dict, checkpoint: bool, tasks) -> dict:
    """Clamp a classifier answer into the gateway's fields (anything missing gets a cautious default)."""
    def num(v, lo, hi, default):
        try:
            return max(lo, min(hi, type(default)(v)))
        except (TypeError, ValueError):
            return default
    task = out.get("task") if out.get("task") in tasks and (checkpoint or out.get("task") != "mechanical") else "qa"
    c = num(out.get("complexity"), 1, 5, 3)
    return {"task": task, "complexity": c, "reasoning_depth": num(out.get("reasoning_depth"), 1, 5, c),
            "uncertainty": num(out.get("uncertainty"), 0.0, 1.0, 0.3),
            "scope": out.get("scope") if out.get("scope") in SCOPES else "medium",
            "tool_intensity": num(out.get("tool_intensity"), 0, 3, 1), "risk": bool(out.get("risk")),
            "long_output": bool(out.get("long_output")), "source": "checkpoint" if checkpoint else "llm"}
