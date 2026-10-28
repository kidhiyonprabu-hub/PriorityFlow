import sqlite3
import tempfile
import unittest
from pathlib import Path

import app as priorityflow


class PriorityFlowApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        priorityflow.DB_PATH = Path(self.temp_dir.name) / "test.db"
        self.client = priorityflow.app.test_client()
        self.tasks = self.client.get("/api/tasks").get_json()

    def tearDown(self):
        self.temp_dir.cleanup()

    def create_task(self, title, priority="Medium"):
        response = self.client.post(
            "/api/tasks",
            json={"title": title, "priority": priority},
        )
        self.assertEqual(response.status_code, 201)
        return response.get_json()

    def test_health_dashboard_and_task_crud(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/").status_code, 200)

        task = self.create_task("API review", "High")
        self.assertEqual(self.client.get(f"/api/tasks/{task['id']}").status_code, 200)

        updated = self.client.put(
            f"/api/tasks/{task['id']}",
            json={"status": "Completed", "category": "Engineering"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()["status"], "Completed")
        self.assertEqual(updated.get_json()["category"], "Engineering")

        dashboard = self.client.get("/api/dashboard").get_json()
        self.assertEqual(dashboard["summary"]["total"], 4)
        self.assertEqual(dashboard["summary"]["completed"], 1)

        self.assertEqual(self.client.delete(f"/api/tasks/{task['id']}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/tasks/{task['id']}").status_code, 404)

    def test_task_validation_and_missing_task(self):
        self.assertEqual(self.client.post("/api/tasks", json={"title": "  "}).status_code, 400)
        self.assertEqual(
            self.client.post("/api/tasks", json={"title": "Invalid priority", "priority": "Urgent"}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post("/api/tasks", json={"title": "Invalid duration", "estimated_duration": -1}).status_code,
            400,
        )
        self.assertEqual(self.client.get("/api/tasks/99999").status_code, 404)

    def test_dependency_cycle_rejection_and_cascade(self):
        first = self.create_task("First")
        second = self.create_task("Second")
        self.assertEqual(
            self.client.post(
                "/api/dependencies",
                json={"task_id": first["id"], "dependency_id": second["id"]},
            ).status_code,
            200,
        )
        cycle = self.client.post(
            "/api/dependencies",
            json={"task_id": second["id"], "dependency_id": first["id"]},
        )
        self.assertEqual(cycle.status_code, 400)
        self.assertIn("cycle", cycle.get_json()["error"].lower())

        self.assertEqual(self.client.delete(f"/api/tasks/{second['id']}").status_code, 200)
        self.assertEqual(self.client.get("/api/dependencies").get_json(), [])

    def test_sample_workspace_is_additive_and_idempotent(self):
        created = self.client.post("/api/demo-data", json={})
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.get_json()["created"], 67)
        self.assertEqual(created.get_json()["total"], 70)
        self.assertEqual(len(self.client.get("/api/tasks").get_json()), 70)
        self.assertGreater(len(self.client.get("/api/dependencies").get_json()), 4)
        repeated = self.client.post("/api/demo-data", json={})
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.get_json()["total"], 70)

    def test_legacy_database_schema_is_migrated_without_losing_tasks(self):
        legacy_path = Path(self.temp_dir.name) / "legacy.db"
        connection = sqlite3.connect(legacy_path)
        connection.execute(
            """
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT 'Medium',
                status TEXT NOT NULL DEFAULT 'Pending'
            )
            """
        )
        connection.execute(
            "INSERT INTO tasks (title, priority, status) VALUES (?, ?, ?)",
            ("Legacy task", "High", "Pending"),
        )
        connection.commit()
        connection.close()

        priorityflow.DB_PATH = legacy_path
        legacy_client = priorityflow.app.test_client()
        tasks = legacy_client.get("/api/tasks").get_json()
        legacy = next(task for task in tasks if task["title"] == "Legacy task")
        self.assertEqual(legacy["priority"], "High")
        self.assertEqual(legacy["description"], "")
        self.assertTrue(legacy["created_at"])


if __name__ == "__main__":
    unittest.main()
