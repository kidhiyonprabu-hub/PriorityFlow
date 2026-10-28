import os
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__, template_folder="templates", static_folder="static")

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "priorityflow.db"

PRIORITY_ORDER = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}
VALID_PRIORITIES = list(PRIORITY_ORDER.keys())
VALID_STATUSES = ["Pending", "In Progress", "Completed"]


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exception_type, exception, traceback):
        try:
            return super().__exit__(exception_type, exception, traceback)
        finally:
            self.close()


def get_db_connection():
    conn = sqlite3.connect(DB_PATH, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def utc_timestamp():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_priority(value):
    priority = (value or "Medium").strip().title()
    if priority not in PRIORITY_ORDER:
        raise ValueError("Priority must be one of: Critical, High, Medium, Low")
    return priority


def normalize_status(value):
    status = (value or "Pending").strip()
    if status not in VALID_STATUSES:
        raise ValueError("Status must be one of: Pending, In Progress, Completed")
    return status


def normalize_deadline(value):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError("deadline must be a valid ISO date (YYYY-MM-DD)") from exc


def serialize_task(row):
    if row is None:
        return None
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "priority": row["priority"],
        "status": row["status"],
        "deadline": row["deadline"],
        "category": row["category"],
        "estimated_duration": row["estimated_duration"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def task_index_key(task):
    return (
        -PRIORITY_ORDER.get(task["priority"], 0),
        task["deadline"] or "9999-12-31",
        (task["created_at"] or "1970-01-01T00:00:00"),
    )


def init_db():
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                priority TEXT NOT NULL DEFAULT 'Medium',
                status TEXT NOT NULL DEFAULT 'Pending',
                deadline TEXT,
                category TEXT DEFAULT '',
                estimated_duration INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )

        existing_columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        for column_name, column_sql in {
            "description": "TEXT DEFAULT ''",
            "deadline": "TEXT",
            "category": "TEXT DEFAULT ''",
            "estimated_duration": "INTEGER",
            "created_at": "TEXT",
            "updated_at": "TEXT",
        }.items():
            if column_name not in existing_columns:
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {column_name} {column_sql}")

        conn.execute("UPDATE tasks SET description = COALESCE(description, '') WHERE description IS NULL")
        conn.execute("UPDATE tasks SET category = COALESCE(category, '') WHERE category IS NULL")
        conn.execute(
            "UPDATE tasks SET priority = 'Medium' WHERE priority IS NULL OR priority NOT IN ('Critical', 'High', 'Medium', 'Low')"
        )
        conn.execute(
            "UPDATE tasks SET status = 'Pending' WHERE status IS NULL OR status NOT IN ('Pending', 'In Progress', 'Completed')"
        )
        conn.execute(
            "UPDATE tasks SET created_at = ? WHERE created_at IS NULL OR created_at = ''",
            (utc_timestamp(),),
        )
        conn.execute(
            "UPDATE tasks SET updated_at = COALESCE(updated_at, created_at) WHERE updated_at IS NULL OR updated_at = ''"
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_dependencies (
                task_id INTEGER NOT NULL,
                dependency_id INTEGER NOT NULL,
                PRIMARY KEY (task_id, dependency_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (dependency_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
            """
        )

        if conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0:
            now = utc_timestamp()
            task_rows = [
                (
                    "Finalize sprint plan",
                    "Align delivery milestones and ownership for the upcoming release.",
                    "Critical",
                    "In Progress",
                    "2026-11-03",
                    "Planning",
                    6,
                    now,
                    now,
                ),
                (
                    "Prepare backlog prioritization",
                    "Review low-value work and triage based on customer impact.",
                    "High",
                    "Pending",
                    "2026-11-02",
                    "Operations",
                    4,
                    now,
                    now,
                ),
                (
                    "Refresh UI polish pass",
                    "Tighten spacing and micro-interactions for the dashboard experience.",
                    "Medium",
                    "Pending",
                    "2026-11-05",
                    "Design",
                    3,
                    now,
                    now,
                ),
            ]
            conn.executemany(
                """
                INSERT INTO tasks (
                    title, description, priority, status, deadline,
                    category, estimated_duration, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                task_rows,
            )


def fetch_task(task_id):
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return serialize_task(row)


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "app": "PriorityFlow AI"})


@app.route("/api/tasks", methods=["GET"])
def list_tasks():
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
    tasks = [serialize_task(row) for row in rows]
    tasks.sort(key=task_index_key)
    return jsonify(tasks)


@app.route("/api/tasks", methods=["POST"])
def create_task():
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", "")).strip()
    if not title:
        return jsonify({"error": "Task title is required."}), 400

    try:
        priority = normalize_priority(payload.get("priority"))
        status = normalize_status(payload.get("status"))
        deadline = normalize_deadline(payload.get("deadline"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    description = str(payload.get("description") or "").strip()
    category = str(payload.get("category") or "").strip()
    estimated_duration = payload.get("estimated_duration")
    if estimated_duration in (None, ""):
        estimated_duration = None
    else:
        try:
            estimated_duration = int(estimated_duration)
            if estimated_duration < 0:
                raise ValueError()
        except ValueError:
            return jsonify({"error": "estimated_duration must be a non-negative integer."}), 400

    now = utc_timestamp()
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO tasks (
                title, description, priority, status, deadline,
                category, estimated_duration, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                title,
                description,
                priority,
                status,
                deadline,
                category,
                estimated_duration,
                now,
                now,
            ),
        )
        task_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return jsonify(serialize_task(row)), 201


@app.route("/api/tasks/<int:task_id>", methods=["GET"])
def get_task(task_id):
    task = fetch_task(task_id)
    if task is None:
        return jsonify({"error": "Task not found."}), 404
    return jsonify(task)


@app.route("/api/tasks/<int:task_id>", methods=["PUT"])
def update_task(task_id):
    existing = fetch_task(task_id)
    if existing is None:
        return jsonify({"error": "Task not found."}), 404

    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", existing["title"])).strip()
    if not title:
        return jsonify({"error": "Task title is required."}), 400

    try:
        priority = normalize_priority(payload.get("priority", existing["priority"]))
        status = normalize_status(payload.get("status", existing["status"]))
        deadline = normalize_deadline(payload.get("deadline", existing["deadline"]))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    description = str(payload.get("description", existing["description"]) or "").strip()
    category = str(payload.get("category", existing["category"]) or "").strip()
    estimated_duration = payload.get("estimated_duration", existing["estimated_duration"])
    if estimated_duration in (None, ""):
        estimated_duration = None
    else:
        try:
            estimated_duration = int(estimated_duration)
            if estimated_duration < 0:
                raise ValueError()
        except ValueError:
            return jsonify({"error": "estimated_duration must be a non-negative integer."}), 400

    updated_at = utc_timestamp()
    with get_db_connection() as conn:
        conn.execute(
            """
            UPDATE tasks
            SET title = ?, description = ?, priority = ?, status = ?,
                deadline = ?, category = ?, estimated_duration = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                description,
                priority,
                status,
                deadline,
                category,
                estimated_duration,
                updated_at,
                task_id,
            ),
        )
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return jsonify(serialize_task(row))


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    with get_db_connection() as conn:
        cursor = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        if cursor.rowcount == 0:
            return jsonify({"error": "Task not found."}), 404
    return jsonify({"deleted": True, "task_id": task_id})


@app.route("/api/dashboard")
def dashboard():
    with get_db_connection() as conn:
        tasks = [serialize_task(row) for row in conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()]

    total = len(tasks)
    pending = sum(1 for task in tasks if task["status"] == "Pending")
    in_progress = sum(1 for task in tasks if task["status"] == "In Progress")
    completed = sum(1 for task in tasks if task["status"] == "Completed")

    today = date.today().isoformat()
    overdue = sum(
        1
        for task in tasks
        if task["status"] != "Completed" and task["deadline"] and task["deadline"] < today
    )

    distribution = {level: 0 for level in VALID_PRIORITIES}
    for task in tasks:
        distribution[task["priority"]] += 1

    completion_rate = round((completed / total) * 100, 1) if total else 0.0

    upcoming = sorted(
        [task for task in tasks if task["status"] != "Completed" and task["deadline"]],
        key=lambda task: (task["deadline"], -PRIORITY_ORDER.get(task["priority"], 0)),
    )[:5]

    recommended = None
    if tasks:
        pending_tasks = [task for task in tasks if task["status"] != "Completed"]
        if pending_tasks:
            recommended = sorted(
                pending_tasks,
                key=lambda task: (
                    -PRIORITY_ORDER.get(task["priority"], 0),
                    task["deadline"] or "9999-12-31",
                    task["created_at"],
                ),
            )[0]

    return jsonify(
        {
            "summary": {
                "total": total,
                "pending": pending,
                "in_progress": in_progress,
                "completed": completed,
                "overdue": overdue,
                "completion_rate": completion_rate,
            },
            "priority_distribution": distribution,
            "upcoming_deadlines": upcoming,
            "recommended_task": recommended,
            "tasks": tasks,
        }
    )


@app.route("/api/demo-data", methods=["POST"])
def add_demo_data():
    existing_examples = [
        ("Confirm release scope", "Review goals and success criteria with the project team.", "Critical", "In Progress", "Product", 3, 0),
        ("Resolve payment retry issue", "Check retry behavior and verify error recovery.", "Critical", "Pending", "Engineering", 5, 1),
        ("Review accessibility findings", "Prioritize keyboard and contrast improvements.", "High", "Pending", "Design", 4, 2),
        ("Update onboarding checklist", "Bring the new starter checklist up to date.", "High", "Pending", "Operations", 2, 3),
        ("Prepare sprint demo", "Collect completed work and prepare a short walkthrough.", "High", "Pending", "Planning", 3, 4),
        ("Audit API response times", "Review the latest response-time measurements.", "Medium", "In Progress", "Engineering", 4, 5),
        ("Refresh help center copy", "Clarify the most frequently used help articles.", "Medium", "Pending", "Content", 3, 6),
        ("Tidy design tokens", "Remove unused tokens and document the active palette.", "Medium", "Pending", "Design", 2, 7),
        ("Check mobile navigation", "Verify the workspace at phone and tablet widths.", "High", "Pending", "Design", 2, 8),
        ("Review support themes", "Summarize recurring customer feedback for planning.", "Medium", "Completed", "Research", 3, 9),
        ("Write deployment checklist", "Document the pre-release verification steps.", "Low", "Pending", "Operations", 2, 10),
        ("Archive old project notes", "Move obsolete notes out of the active workspace.", "Low", "Pending", "Planning", 1, 11),
        ("Validate CSV export", "Check exported rows and headers against task records.", "Medium", "Completed", "Engineering", 2, 12),
        ("Plan stakeholder update", "Draft the upcoming project progress summary.", "High", "Pending", "Planning", 2, 13),
        ("Review error messages", "Make validation feedback clear and actionable.", "Medium", "Pending", "Product", 3, 14),
        ("Update team glossary", "Add current terminology used across the workspace.", "Low", "Completed", "Content", 1, 15),
    ]
    workstreams = ["Core platform", "Customer portal", "Release readiness"]
    actions = [
        ("Review requirements", "Confirm acceptance criteria and open questions", "Product"),
        ("Draft implementation plan", "Break the work into small, verifiable delivery steps", "Engineering"),
        ("Prepare test cases", "Cover successful flows, boundary values, and error handling", "Quality"),
        ("Run regression checks", "Verify recent changes against existing workflows", "Quality"),
        ("Review open defects", "Triage findings and agree on owners and next steps", "Engineering"),
        ("Update runbook", "Document support procedures and recovery guidance", "Operations"),
        ("Validate usage metrics", "Check reporting values against the underlying records", "Analytics"),
        ("Schedule stakeholder review", "Prepare decisions and a concise progress update", "Planning"),
        ("Confirm rollout criteria", "Set release checks and rollback expectations", "Operations"),
        ("Prepare release notes", "Summarize user-facing changes and known limitations", "Content"),
        ("Check keyboard navigation", "Test focus order and keyboard-only interaction", "Design"),
        ("Review security findings", "Verify mitigations and record any follow-up actions", "Engineering"),
        ("Measure page performance", "Record load time and identify slow interactions", "Engineering"),
        ("Clean up backlog", "Remove duplicates and clarify the highest-value work", "Planning"),
        ("Document API behavior", "Record request fields, responses, and validation rules", "Engineering"),
        ("Verify responsive layout", "Check the main workflows at mobile and tablet sizes", "Design"),
        ("Collect final sign-off", "Confirm owners have reviewed the completed deliverable", "Planning"),
    ]

    sample_tasks = list(existing_examples)
    for action_index, (action, description, category) in enumerate(actions):
        for stream_index, workstream in enumerate(workstreams):
            item_index = action_index * len(workstreams) + stream_index
            priorities = ["Critical", "High", "Medium", "Low"]
            statuses = ["Pending", "In Progress", "Completed", "Pending", "Pending", "Completed", "Pending"]
            sample_tasks.append(
                (
                    f"{action} · {workstream}",
                    f"{description} for the {workstream.lower()} workstream.",
                    priorities[item_index % len(priorities)],
                    statuses[item_index % len(statuses)],
                    f"Sample · {category}",
                    1 + item_index % 8,
                    item_index % 24 - 5,
                )
            )

    now = datetime.now(timezone.utc).replace(microsecond=0)
    with get_db_connection() as conn:
        existing_count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        if existing_count >= 70:
            return jsonify(
                {
                    "created": 0,
                    "total": existing_count,
                    "message": f"Your workspace already has {existing_count} tasks.",
                }
            )

        task_ids = []
        added = 0
        for index, (title, description, priority, status, category, hours, due_in_days) in enumerate(sample_tasks):
            if conn.execute("SELECT 1 FROM tasks WHERE title = ? LIMIT 1", (title,)).fetchone():
                continue
            if existing_count + added >= 70:
                break

            created_at = (now - timedelta(days=(index * 7) % 35)).isoformat().replace("+00:00", "Z")
            updated_at = (now - timedelta(days=(index * 3) % 14)).isoformat().replace("+00:00", "Z")
            deadline = (date.today() + timedelta(days=due_in_days)).isoformat()
            cursor = conn.execute(
                """
                INSERT INTO tasks (
                    title, description, priority, status, deadline,
                    category, estimated_duration, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    title,
                    description,
                    priority,
                    status,
                    deadline,
                    category,
                    hours,
                    created_at,
                    updated_at,
                ),
            )
            task_ids.append(cursor.lastrowid)
            added += 1

        for task_index, prerequisite_index in [(1, 0), (4, 2), (8, 6), (13, 4)]:
            if task_index >= len(task_ids):
                continue
            conn.execute(
                "INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)",
                (task_ids[task_index], task_ids[prerequisite_index]),
            )

        for task_index in range(2, len(task_ids), 3):
            prerequisite_index = task_index - 1
            conn.execute(
                "INSERT OR IGNORE INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)",
                (task_ids[task_index], task_ids[prerequisite_index]),
            )

        total = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]

    return jsonify(
        {
            "created": added,
            "total": total,
            "message": f"Added {added} sample tasks. Your workspace now has {total} tasks.",
        }
    ), 201


@app.route("/api/dependencies", methods=["GET"])
def list_dependencies():
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT d.task_id, d.dependency_id, t.title AS task_title, p.title AS dependency_title
            FROM task_dependencies d
            JOIN tasks t ON t.id = d.task_id
            JOIN tasks p ON p.id = d.dependency_id
            ORDER BY d.task_id, d.dependency_id
            """
        ).fetchall()
    return jsonify([
        {
            "task_id": row["task_id"],
            "dependency_id": row["dependency_id"],
            "task_title": row["task_title"],
            "dependency_title": row["dependency_title"],
        }
        for row in rows
    ])


@app.route("/api/dependencies", methods=["POST"])
def add_dependency():
    payload = request.get_json(silent=True) or {}
    task_id = payload.get("task_id")
    dependency_id = payload.get("dependency_id")
    if task_id in (None, "") or dependency_id in (None, ""):
        return jsonify({"error": "task_id and dependency_id are required."}), 400
    try:
        task_id = int(task_id)
        dependency_id = int(dependency_id)
    except ValueError:
        return jsonify({"error": "task_id and dependency_id must be integers."}), 400
    if task_id == dependency_id:
        return jsonify({"error": "Self-dependencies are not allowed."}), 400

    with get_db_connection() as conn:
        if conn.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)).fetchone() is None:
            return jsonify({"error": "Task not found."}), 404
        if conn.execute("SELECT 1 FROM tasks WHERE id = ?", (dependency_id,)).fetchone() is None:
            return jsonify({"error": "Dependency task not found."}), 404
        if conn.execute(
            "SELECT 1 FROM task_dependencies WHERE task_id = ? AND dependency_id = ?",
            (task_id, dependency_id),
        ).fetchone():
            return jsonify({"error": "Dependency already exists."}), 400

        # Prevent cycles before inserting a dependency edge.
        adjacency = {}
        for row in conn.execute("SELECT task_id, dependency_id FROM task_dependencies").fetchall():
            adjacency.setdefault(row["task_id"], []).append(row["dependency_id"])
        adjacency.setdefault(task_id, [])
        adjacency.setdefault(dependency_id, [])
        adjacency[task_id].append(dependency_id)

        visited = set()
        stack = set()

        def has_cycle(node):
            visited.add(node)
            stack.add(node)
            for neighbor in adjacency.get(node, []):
                if neighbor not in visited:
                    if has_cycle(neighbor):
                        return True
                elif neighbor in stack:
                    return True
            stack.remove(node)
            return False

        if has_cycle(task_id):
            return jsonify({"error": "Dependency cycle detected."}), 400

        conn.execute(
            "INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)",
            (task_id, dependency_id),
        )

    return jsonify({"task_id": task_id, "dependency_id": dependency_id, "status": "created"})


@app.route("/api/dependencies/<int:task_id>/<int:dependency_id>", methods=["DELETE"])
def remove_dependency(task_id, dependency_id):
    with get_db_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM task_dependencies WHERE task_id = ? AND dependency_id = ?",
            (task_id, dependency_id),
        )
        if cursor.rowcount == 0:
            return jsonify({"error": "Dependency not found."}), 404
    return jsonify({"status": "deleted", "task_id": task_id, "dependency_id": dependency_id})


@app.errorhandler(404)
def handle_not_found(error):
    return jsonify({"error": "Resource not found."}), 404


@app.errorhandler(405)
def handle_method_not_allowed(error):
    return jsonify({"error": "Method not allowed."}), 405


@app.before_request
def setup_database():
    init_db()


if __name__ == "__main__":
    init_db()
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=bool(os.getenv("FLASK_DEBUG", "0") == "1"),
    )
