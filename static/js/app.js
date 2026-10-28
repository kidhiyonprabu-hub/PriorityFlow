
const $ = (id) => document.getElementById(id);

const priorityScore = { Critical: 4, High: 3, Medium: 2, Low: 1 };
let tasks = [];
let editingTaskId = null;

function notify(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(notify.timeoutId);
  notify.timeoutId = window.setTimeout(() => toast.classList.remove("show"), 2400);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function getVisibleTasks() {
  const query = $("search").value.toLowerCase();
  const filter = $("filter").value;
  const statusFilter = $("status-filter").value;
  const deadlineFilter = $("deadline-filter").value;
  const sort = $("sort").value;
  const today = new Date().toISOString().slice(0, 10);

  const visible = tasks.filter((task) => {
    const searchTarget = `${task.title} ${task.description || ""}`.toLowerCase();
    const deadlineMatches = !deadlineFilter
      || (deadlineFilter === "none" && !task.deadline)
      || (deadlineFilter === "overdue" && task.deadline && task.deadline < today && task.status !== "Completed")
      || (deadlineFilter === "upcoming" && task.deadline && task.deadline >= today && task.status !== "Completed");
    return searchTarget.includes(query)
      && (!filter || task.priority === filter)
      && (!statusFilter || task.status === statusFilter)
      && deadlineMatches;
  });

  visible.sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "effort") return (a.estimated_duration ?? Number.POSITIVE_INFINITY) - (b.estimated_duration ?? Number.POSITIVE_INFINITY);
    if (sort === "deadline") {
      return (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31");
    }
    return (priorityScore[b.priority] || 0) - (priorityScore[a.priority] || 0)
      || (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31")
      || a.id - b.id;
  });

  return visible;
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    tasks = data.tasks || [];
    render();
  } catch (error) {
    notify(error.message);
  }
}

function render() {
  const summary = tasks.length ? tasks.reduce((acc, task) => {
    acc.total += 1;
    acc.pending += task.status === "Pending" ? 1 : 0;
    acc.inProgress += task.status === "In Progress" ? 1 : 0;
    acc.completed += task.status === "Completed" ? 1 : 0;
    return acc;
  }, { total: 0, pending: 0, inProgress: 0, completed: 0 }) : { total: 0, pending: 0, inProgress: 0, completed: 0 };

  $("total").textContent = String(summary.total);
  $("pending").textContent = String(summary.pending);
  $("progress").textContent = String(summary.inProgress);
  $("completed").textContent = String(summary.completed);
  const today = new Date().toISOString().slice(0, 10);
  const overdueTasks = tasks.filter((task) => task.status !== "Completed" && task.deadline && task.deadline < today);
  $("overdue").textContent = String(overdueTasks.length);
  $("completion-rate").textContent = `${summary.total ? Math.round((summary.completed / summary.total) * 100) : 0}%`;

  const distribution = Object.keys(priorityScore).map((priority) => ({
    priority,
    count: tasks.filter((task) => task.priority === priority).length,
  }));
  const maxPriorityCount = Math.max(1, ...distribution.map((item) => item.count));
  $("priority-bars").innerHTML = distribution.map((item) => `
    <div class="priority-bar-row">
      <span>${item.priority}</span>
      <div class="priority-bar-track"><div class="priority-bar-fill" style="width:${(item.count / maxPriorityCount) * 100}%"></div></div>
      <strong>${item.count}</strong>
    </div>
  `).join("");

  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(Date.now() - (6 - index) * 86400000);
    return { date: day.toISOString().slice(0, 10), label: day.toLocaleDateString(undefined, { weekday: "short" }) };
  });
  const weeklyCounts = weekDays.map((day) => tasks.filter((task) => task.status === "Completed"
    && task.updated_at && task.updated_at.slice(0, 10) === day.date).length);
  const maxWeeklyCount = Math.max(1, ...weeklyCounts);
  $("weekly-chart").innerHTML = weekDays.map((day, index) => `
    <div class="week-day">
      <div class="week-bar-track"><span class="week-bar" style="height:${(weeklyCounts[index] / maxWeeklyCount) * 100}%" title="${weeklyCounts[index]} completed"></span></div>
      <span class="week-count">${weeklyCounts[index]}</span>${day.label}
    </div>
  `).join("");

  const upcoming = tasks.filter((task) => task.status !== "Completed" && task.deadline && task.deadline >= today)
    .sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 5);
  $("upcoming-deadlines").innerHTML = upcoming.map((task) => `
    <div class="upcoming-item"><span>${escapeHTML(task.title)}</span><strong>${escapeHTML(task.deadline)}</strong></div>
  `).join("") || '<div class="task-desc">No upcoming deadlines. Add a task deadline to see it here.</div>';

  const insertSelect = $("heap-insert-task");
  const selectedTaskId = insertSelect.value;
  insertSelect.innerHTML = tasks
    .filter((task) => task.status !== "Completed")
    .map((task) => `<option value="${task.id}">${escapeHTML(task.title)} · ${task.priority}</option>`)
    .join("") || '<option value="">No active tasks</option>';
  if ([...insertSelect.options].some((option) => option.value === selectedTaskId)) {
    insertSelect.value = selectedTaskId;
  }

  const visible = getVisibleTasks();
  $("task-list").innerHTML = visible.map((task) => `
    <tr>
      <td>
        <div class="task-title">${escapeHTML(task.title)}</div>
        <div class="task-desc">${escapeHTML(task.description || "")}</div>
      </td>
      <td><span class="tag ${task.priority}">${task.priority}</span></td>
      <td>
        <select class="status-select" data-status="${task.id}">
          ${["Pending", "In Progress", "Completed"].map((status) => `
            <option value="${status}" ${task.status === status ? "selected" : ""}>${status}</option>
          `).join("")}
        </select>
      </td>
      <td>${escapeHTML(task.deadline || "—")}</td>
      <td>${escapeHTML(task.category || "—")}</td>
      <td>${task.estimated_duration != null ? `${task.estimated_duration}h` : "—"}</td>
      <td>
        <button class="action-btn" data-edit="${task.id}">Edit</button>
        <button class="action-btn delete-btn" data-delete="${task.id}">Delete</button>
      </td>
    </tr>
  `).join("");

  $("empty").classList.toggle("hidden", visible.length > 0);

  const next = [...tasks]
    .filter((task) => task.status !== "Completed")
    .sort((a, b) => (priorityScore[b.priority] || 0) - (priorityScore[a.priority] || 0)
      || (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31"))[0];

  $("next-task").textContent = next
    ? `${next.title} · ${next.priority} priority · ${next.deadline || "No deadline"}`
    : "No pending tasks";
}

function resetTaskForm() {
  editingTaskId = null;
  $("task-form").reset();
  $("task-id").value = "";
  $("task-form").classList.add("hidden");
}

function fillTaskForm(task) {
  editingTaskId = task.id;
  const form = $("task-form");
  form.elements.title.value = task.title || "";
  form.elements.description.value = task.description || "";
  form.elements.priority.value = task.priority || "Medium";
  form.elements.status.value = task.status || "Pending";
  form.elements.deadline.value = task.deadline || "";
  form.elements.category.value = task.category || "";
  form.elements.estimated_duration.value = task.estimated_duration ?? "";
  $("task-id").value = String(task.id);
  form.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("add-toggle").addEventListener("click", () => {
  if ($("task-form").classList.contains("hidden")) {
    resetTaskForm();
    $("task-form").classList.remove("hidden");
  } else {
    resetTaskForm();
  }
});

$("open-tasks").addEventListener("click", () => switchPage("tasks"));
$("dashboard-add").addEventListener("click", () => {
  switchPage("tasks");
  resetTaskForm();
  $("task-form").classList.remove("hidden");
  $("task-form").elements.title.focus();
});

$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const payload = Object.fromEntries(formData.entries());

  if (payload.title) {
    payload.title = payload.title.trim();
  }
  if (payload.description !== undefined) {
    payload.description = payload.description.trim();
  }
  if (payload.category !== undefined) {
    payload.category = payload.category.trim();
  }
  if (payload.deadline === "") {
    delete payload.deadline;
  }
  if (payload.estimated_duration === "") {
    delete payload.estimated_duration;
  }

  try {
    if (editingTaskId) {
      await api(`/api/tasks/${editingTaskId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      notify("Task updated successfully!");
    } else {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      notify("Task created successfully!");
    }
    resetTaskForm();
    await loadDashboard();
  } catch (error) {
    notify(error.message);
  }
});

$("task-list").addEventListener("change", async (event) => {
  if (!event.target.dataset.status) return;

  const id = event.target.dataset.status;
  try {
    await api(`/api/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify({ status: event.target.value }),
    });
    await loadDashboard();
    notify("Task status updated!");
  } catch (error) {
    notify(error.message);
  }
});

$("task-list").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    if (!window.confirm("Delete this task?")) return;
    try {
      await api(`/api/tasks/${deleteButton.dataset.delete}`, { method: "DELETE" });
      await loadDashboard();
      notify("Task deleted!");
    } catch (error) {
      notify(error.message);
    }
    return;
  }

  const editButton = event.target.closest("[data-edit]");
  if (!editButton) return;
  const task = tasks.find((item) => String(item.id) === editButton.dataset.edit);
  if (task) fillTaskForm(task);
});

["search", "filter", "status-filter", "deadline-filter", "sort"].forEach((id) => {
  $(id).addEventListener(id === "search" ? "input" : "change", render);
});

function switchPage(page) {
    document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active"));
    const activeButton = document.querySelector(`.nav[data-page="${page}"]`);
    if (activeButton) activeButton.classList.add("active");

    const titles = {
      dashboard: "Dashboard Overview",
      tasks: "My Tasks",
      queue: "Priority Queue",
      algorithms: "Algorithm Lab",
      graph: "Dependency Graph",
    };

    $("page-title").textContent = titles[page] || "Dashboard Overview";
    document.querySelectorAll("[data-page-view]").forEach((section) => {
      section.classList.toggle("hidden", section.dataset.pageView !== page);
    });
    if (page === "queue") renderHeap();
    if (page === "algorithms") prepareLab();
    if (page === "graph") loadGraph();
}

document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    switchPage(button.dataset.page);
  });
});

const heap = [];
let heapHistory = [];
let heapStep = 0;

function compareHeapItems(left, right) {
  const priorityDifference = (priorityScore[left.priority] || 0) - (priorityScore[right.priority] || 0);
  if (priorityDifference !== 0) return priorityDifference;
  const deadlineDifference = (left.deadline || "9999-12-31").localeCompare(right.deadline || "9999-12-31");
  if (deadlineDifference !== 0) return -deadlineDifference;
  return String(right.created_at || "").localeCompare(String(left.created_at || ""))
    || Number(right.id) - Number(left.id);
}

function saveHeapStep(label) {
  heapHistory.push({ label, items: heap.map((task) => ({ ...task })) });
}

function siftDown(index) {
  let parent = index;
  while (true) {
    const left = 2 * parent + 1;
    const right = left + 1;
    let best = parent;
    if (left < heap.length && compareHeapItems(heap[left], heap[best]) > 0) best = left;
    if (right < heap.length && compareHeapItems(heap[right], heap[best]) > 0) best = right;
    if (best === parent) break;
    [heap[parent], heap[best]] = [heap[best], heap[parent]];
    parent = best;
    saveHeapStep("Sift down: swapped a child above its parent");
  }
}

function insertHeapTask() {
  const taskId = Number($("heap-insert-task").value);
  const task = tasks.find((item) => Number(item.id) === taskId);
  if (!task || task.status === "Completed") {
    notify("Choose an active task to insert into the heap.");
    return;
  }
  if (heap.some((item) => Number(item.id) === taskId)) {
    notify("That task is already in the heap.");
    return;
  }
  heapHistory = [{ label: "Before insertion", items: heap.map((item) => ({ ...item })) }];
  heap.push(task);
  let index = heap.length - 1;
  saveHeapStep("Insert at the end of the heap array");
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareHeapItems(heap[index], heap[parent]) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
    saveHeapStep("Sift up: swap the inserted task with its parent");
  }
  saveHeapStep("Insert complete · O(log n)");
  heapStep = heapHistory.length - 1;
  renderHeap();
  notify(`Inserted ${task.title} into the heap.`);
}

function buildHeap() {
  heap.splice(0, heap.length, ...tasks.filter((task) => task.status !== "Completed"));
  heapHistory = [];
  heapStep = 0;
  saveHeapStep("Starting array from active tasks");
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) {
    siftDown(index);
  }
  saveHeapStep("Heapify complete · O(n)");
  heapStep = heapHistory.length - 1;
  renderHeap();
  notify(`Built a max heap from ${heap.length} active tasks.`);
}

function extractHeapMax() {
  if (!heap.length) {
    notify("Build a heap with active tasks first.");
    return;
  }
  heapHistory = [{ label: "Before extraction", items: heap.map((task) => ({ ...task })) }];
  const extracted = heap[0];
  if (heap.length === 1) {
    heap.pop();
  } else {
    heap[0] = heap.pop();
    saveHeapStep("Move last item to the root");
    siftDown(0);
  }
  saveHeapStep(`Extracted maximum: ${extracted.title}`);
  heapStep = heapHistory.length - 1;
  renderHeap();
  notify(`Extracted ${extracted.title}.`);
}

function renderHeap() {
  const state = heapHistory[heapStep];
  const items = state ? state.items : heap;
  $("heap-step-label").textContent = state ? state.label : "Build heap to inspect each real algorithm state.";
  $("heap-peak").textContent = items.length ? `${items[0].title} · ${items[0].priority}` : "No active tasks in heap";
  $("heap-step-count").textContent = `${heapHistory.length ? heapStep + 1 : 0} / ${heapHistory.length}`;
  $("heap-prev").disabled = heapStep <= 0;
  $("heap-next").disabled = heapStep >= heapHistory.length - 1;
  $("heap-array").innerHTML = items.map((task, index) => `
    <div class="heap-cell"><strong>[${index}] · ${task.priority}</strong>${escapeHTML(task.title)}</div>
  `).join("") || '<div class="empty">There are no active tasks to display.</div>';

  if (!items.length) {
    $("heap-tree").innerHTML = '<div class="empty">No heap nodes yet. Create tasks or add the sample workspace.</div>';
    return;
  }

  const depth = Math.ceil(Math.log2(items.length + 1));
  const width = Math.max(760, (2 ** Math.max(0, depth - 1)) * 112);
  const height = depth * 92 + 35;
  const points = items.map((task, index) => {
    const level = Math.floor(Math.log2(index + 1));
    const position = index - (2 ** level - 1);
    const slots = 2 ** level;
    return { task, index, x: (width / slots) * (position + 0.5), y: 45 + level * 92 };
  });
  const edges = points.filter((point) => point.index > 0).map((point) => {
    const parent = points[Math.floor((point.index - 1) / 2)];
    return `<line x1="${parent.x}" y1="${parent.y + 22}" x2="${point.x}" y2="${point.y - 22}" class="graph-edge"/>`;
  }).join("");
  const nodes = points.map(({ task, index, x, y }) => `
    <g class="graph-node ${task.status === "Completed" ? "completed" : "pending"} ${task.priority === "Critical" ? "critical" : ""}">
      <circle cx="${x}" cy="${y}" r="26"></circle>
      <text x="${x}" y="${y - 2}">${task.priority}</text>
      <text x="${x}" y="${y + 11}" class="node-status">#${index}</text>
      <title>${escapeHTML(task.title)}</title>
    </g>
  `).join("");
  $("heap-tree").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Binary max heap tree">${edges}${nodes}</svg>`;
}

function heapMove(step) {
  if (!heapHistory.length) return;
  heapStep = Math.max(0, Math.min(heapHistory.length - 1, heapStep + step));
  renderHeap();
}

$("heap-build").addEventListener("click", buildHeap);
$("heap-insert").addEventListener("click", insertHeapTask);
$("heap-extract").addEventListener("click", extractHeapMax);
$("heap-reset").addEventListener("click", () => {
  heap.splice(0);
  heapHistory = [];
  heapStep = 0;
  renderHeap();
});
$("heap-prev").addEventListener("click", () => heapMove(-1));
$("heap-next").addEventListener("click", () => heapMove(1));

let labFrames = [];
let labStep = 0;
let labTimer = null;
let labResult = null;

function fieldValue(task, field) {
  if (field === "estimated_duration") return task.estimated_duration == null ? Number.POSITIVE_INFINITY : Number(task.estimated_duration);
  if (field === "deadline") return task.deadline || "9999-12-31";
  if (field === "priority") return priorityScore[task.priority] || 0;
  return task.title.toLowerCase();
}

function fieldLabel(task, field) {
  if (field === "estimated_duration") return task.estimated_duration == null ? "—" : `${task.estimated_duration}h`;
  return task[field] || (field === "deadline" ? "No deadline" : "—");
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function prepareLab() {
  clearInterval(labTimer);
  labTimer = null;
  const operation = $("lab-operation").value;
  const algorithm = $("lab-algorithm");
  const targetWrap = $("lab-target-wrap");
  targetWrap.classList.toggle("hidden", operation !== "search");
  algorithm.innerHTML = operation === "search"
    ? '<option value="linear">Linear Search</option><option value="binary">Binary Search</option>'
    : '<option value="bubble">Bubble Sort</option><option value="merge">Merge Sort</option>';
  renderLab();
}

function prepareSearch() {
  const field = $("lab-field").value;
  const algorithm = $("lab-algorithm").value;
  const targetInput = $("lab-target").value.trim();
  let data = tasks.map((task) => ({ ...task }));
  if (algorithm === "binary") {
    data.sort((a, b) => compareValues(fieldValue(a, field), fieldValue(b, field)));
  }
  const priorityTarget = Object.keys(priorityScore).find((priority) => priority.toLowerCase() === targetInput.toLowerCase());
  const target = field === "priority" ? (priorityTarget ? priorityScore[priorityTarget] : targetInput) : field === "estimated_duration" ? Number(targetInput) : targetInput.toLowerCase();
  labFrames = [{ message: algorithm === "binary" ? "Dataset sorted for binary search before the first comparison." : "Linear search checks values one at a time.", values: data, current: [], comparisons: 0, swaps: 0, found: [] }];
  let comparisons = 0;
  let resultIndex = -1;
  if (algorithm === "linear") {
    for (let index = 0; index < data.length; index += 1) {
      comparisons += 1;
      const currentValue = fieldValue(data[index], field);
      const isMatch = field === "priority" && typeof target === "number"
        ? currentValue === target
        : String(currentValue).toLowerCase() === String(target).toLowerCase();
      labFrames.push({ message: `Compare ${fieldLabel(data[index], field)} with "${targetInput}".`, values: data, current: [index], comparisons, swaps: 0, found: isMatch ? [index] : [] });
      if (isMatch) {
        resultIndex = index;
        break;
      }
    }
  } else {
    let low = 0;
    let high = data.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      comparisons += 1;
      const currentValue = fieldValue(data[middle], field);
      const targetValue = field === "priority" && typeof target === "number" ? target : target;
      const cmp = compareValues(currentValue, targetValue);
      const isMatch = field === "priority" && typeof target === "number"
        ? currentValue === target
        : String(currentValue).toLowerCase() === String(target).toLowerCase();
      labFrames.push({ message: `Range [${low}…${high}], compare middle value ${fieldLabel(data[middle], field)}.`, values: data, current: [middle], comparisons, swaps: 0, found: isMatch ? [middle] : [] });
      if (isMatch) {
        resultIndex = middle;
        break;
      }
      if (cmp < 0) low = middle + 1;
      else high = middle - 1;
    }
  }
  labResult = { resultIndex, comparisons, operation: "search" };
  if (resultIndex >= 0) {
    labFrames.push({ ...labFrames[labFrames.length - 1], message: `Found "${data[resultIndex].title}".`, found: [resultIndex] });
  } else {
    labFrames.push({ ...labFrames[labFrames.length - 1], message: `No matching task found for "${targetInput}".` });
  }
}

function prepareBubbleSort(data, field) {
  const values = [...data];
  const frames = [{ message: "Starting values before bubble sort.", values: [...values], current: [], comparisons: 0, swaps: 0, sorted: [] }];
  let comparisons = 0;
  let swaps = 0;
  for (let end = values.length - 1; end > 0; end -= 1) {
    for (let index = 0; index < end; index += 1) {
      comparisons += 1;
      const order = compareValues(fieldValue(values[index], field), fieldValue(values[index + 1], field));
      frames.push({ message: `Compare positions ${index} and ${index + 1}.`, values: [...values], current: [index, index + 1], comparisons, swaps, sorted: [] });
      if (order > 0) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        swaps += 1;
        frames.push({ message: "Out of order: swap neighboring values.", values: [...values], current: [index, index + 1], comparisons, swaps, sorted: [] });
      }
    }
    frames.push({ message: `${values[end].title} is now in its final position.`, values: [...values], current: [], comparisons, swaps, sorted: Array.from({ length: data.length - end }, (_, offset) => end + offset) });
  }
  frames.push({ message: "Bubble sort complete.", values: [...values], current: [], comparisons, swaps, sorted: values.map((_, index) => index) });
  return { frames, comparisons, swaps };
}

function prepareMergeSort(data, field) {
  const values = [...data];
  const frames = [{ message: "Starting values before merge sort.", values: [...values], current: [], comparisons: 0, swaps: 0, sorted: [] }];
  let comparisons = 0;
  let writes = 0;
  function mergeSort(start, end) {
    if (end - start < 2) return;
    const middle = Math.floor((start + end) / 2);
    mergeSort(start, middle);
    mergeSort(middle, end);
    const left = values.slice(start, middle);
    const right = values.slice(middle, end);
    let leftIndex = 0;
    let rightIndex = 0;
    let targetIndex = start;
    while (leftIndex < left.length && rightIndex < right.length) {
      comparisons += 1;
      const chooseLeft = compareValues(fieldValue(left[leftIndex], field), fieldValue(right[rightIndex], field)) <= 0;
      frames.push({ message: `Compare values in merge range [${start}…${end - 1}].`, values: [...values], current: [start + leftIndex, middle + rightIndex], comparisons, swaps: writes, sorted: [] });
      values[targetIndex] = chooseLeft ? left[leftIndex++] : right[rightIndex++];
      writes += 1;
      targetIndex += 1;
      frames.push({ message: "Write the next smallest value into the merged range.", values: [...values], current: [targetIndex - 1], comparisons, swaps: writes, sorted: [] });
    }
    while (leftIndex < left.length) {
      values[targetIndex] = left[leftIndex++];
      writes += 1;
      targetIndex += 1;
      frames.push({ message: "Copy the remaining left-side value.", values: [...values], current: [targetIndex - 1], comparisons, swaps: writes, sorted: [] });
    }
    while (rightIndex < right.length) {
      values[targetIndex] = right[rightIndex++];
      writes += 1;
      targetIndex += 1;
      frames.push({ message: "Copy the remaining right-side value.", values: [...values], current: [targetIndex - 1], comparisons, swaps: writes, sorted: [] });
    }
  }
  mergeSort(0, values.length);
  frames.push({ message: "Merge sort complete.", values: [...values], current: [], comparisons, swaps: writes, sorted: values.map((_, index) => index) });
  return { frames, comparisons, swaps: writes };
}

function runLab() {
  clearInterval(labTimer);
  labTimer = null;
  const operation = $("lab-operation").value;
  const algorithm = $("lab-algorithm").value;
  const field = $("lab-field").value;
  if (!tasks.length) {
    $("lab-status").textContent = "Add tasks first or load the sample workspace.";
    return;
  }
  if (operation === "search") {
    if (!$("lab-target").value.trim()) {
      $("lab-status").textContent = "Enter a search value to run the search.";
      $("lab-target").focus();
      return;
    }
    prepareSearch();
    $("lab-complexity").textContent = algorithm === "binary" ? "O(log n) · sorted input" : "O(n)";
    $("lab-explanation").textContent = algorithm === "binary"
      ? "Binary search needs sorted input. This lab orders the chosen task field first, then halves its search range."
      : "Linear search scans the real task dataset from left to right until it finds a match or reaches the end.";
  } else {
    const result = algorithm === "bubble" ? prepareBubbleSort(tasks, field) : prepareMergeSort(tasks, field);
    labFrames = result.frames;
    labResult = { operation: "sort", comparisons: result.comparisons, swaps: result.swaps };
    $("lab-complexity").textContent = algorithm === "bubble" ? "Best / Avg / Worst O(n²)" : "Best/Avg/Worst O(n log n)";
    $("lab-explanation").textContent = algorithm === "bubble"
      ? "Bubble sort compares adjacent task values and swaps them in place. This standard classroom implementation uses O(n²) comparisons in best, average, and worst cases."
      : "Merge sort recursively divides the real task list and merges sorted halves. It uses additional space proportional to n.";
  }
  labStep = 0;
  renderLab();
}

function renderLab() {
  const frame = labFrames[labStep];
  if (!frame) {
    $("lab-values").innerHTML = "";
    $("lab-comparisons").textContent = "0";
    $("lab-swaps").textContent = "0";
    return;
  }
  const field = $("lab-field").value;
  const currentIndexes = frame.current || [];
  const foundIndexes = frame.found || [];
  const sortedIndexes = frame.sorted || [];
  $("lab-values").innerHTML = frame.values.map((task, index) => `
    <div class="lab-value ${currentIndexes.includes(index) ? "current" : ""} ${foundIndexes.includes(index) ? "found" : ""} ${sortedIndexes.includes(index) ? "sorted" : ""}" title="${escapeHTML(task.title)}">
      ${escapeHTML(fieldLabel(task, field))}
    </div>
  `).join("");
  $("lab-status").textContent = frame.message;
  $("lab-comparisons").textContent = String(frame.comparisons);
  $("lab-swaps").textContent = String(frame.swaps);
}

function nextLabStep() {
  if (labStep >= labFrames.length - 1) {
    clearInterval(labTimer);
    labTimer = null;
    return;
  }
  labStep += 1;
  renderLab();
  if (labStep === labFrames.length - 1 && labResult?.operation === "search") {
    $("lab-status").textContent += labResult.resultIndex >= 0
      ? ` · Found after ${labResult.comparisons} comparison(s).`
      : ` · Not found after ${labResult.comparisons} comparison(s).`;
  }
}

$("lab-operation").addEventListener("change", prepareLab);
$("lab-algorithm").addEventListener("change", () => {
  clearInterval(labTimer);
  labTimer = null;
  labFrames = [];
  $("lab-status").textContent = "Choose Prepare algorithm to start a new run.";
  renderLab();
});
$("lab-run").addEventListener("click", runLab);
$("lab-step").addEventListener("click", nextLabStep);
$("lab-play").addEventListener("click", () => {
  if (!labFrames.length) runLab();
  if (labFrames.length && !labTimer) labTimer = window.setInterval(nextLabStep, Number($("lab-speed").value));
});
$("lab-pause").addEventListener("click", () => {
  clearInterval(labTimer);
  labTimer = null;
});
$("lab-reset").addEventListener("click", () => {
  clearInterval(labTimer);
  labTimer = null;
  labStep = 0;
  renderLab();
});

let graphEdges = [];
let traversalNodes = [];

async function loadGraph() {
  try {
    graphEdges = await api("/api/dependencies");
    const options = tasks.map((task) => `<option value="${task.id}">${escapeHTML(task.title)}</option>`).join("");
    ["graph-task", "graph-dependency", "graph-start"].forEach((id) => {
      const select = $(id);
      const previous = select.value;
      select.innerHTML = options || '<option value="">No tasks available</option>';
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    });
    renderGraph();
  } catch (error) {
    $("graph-status").textContent = error.message;
  }
}

function graphAdjacency() {
  const adjacency = new Map(tasks.map((task) => [Number(task.id), []]));
  graphEdges.forEach((edge) => {
    const from = Number(edge.dependency_id);
    const to = Number(edge.task_id);
    if (adjacency.has(from) && adjacency.has(to)) adjacency.get(from).push(to);
  });
  adjacency.forEach((neighbors) => neighbors.sort((a, b) => a - b));
  return adjacency;
}

function renderGraph() {
  const adjacency = graphAdjacency();
  const blockedTaskIds = new Set(graphEdges
    .filter((edge) => tasks.some((task) => Number(task.id) === Number(edge.dependency_id) && task.status !== "Completed"))
    .map((edge) => Number(edge.task_id)));
  const cols = Math.max(1, Math.ceil(Math.sqrt(tasks.length)));
  const positions = new Map();
  tasks.forEach((task, index) => {
    positions.set(Number(task.id), {
      x: 100 + (index % cols) * Math.max(200, 760 / cols),
      y: 70 + Math.floor(index / cols) * 112,
    });
  });
  const width = Math.max(800, 180 + cols * Math.max(200, 760 / cols));
  const height = Math.max(300, 120 + Math.ceil(tasks.length / cols) * 112);
  const edges = graphEdges.map((edge) => {
    const from = positions.get(Number(edge.dependency_id));
    const to = positions.get(Number(edge.task_id));
    if (!from || !to) return "";
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="graph-edge" marker-end="url(#arrow)"><title>${escapeHTML(edge.dependency_title)} is a prerequisite for ${escapeHTML(edge.task_title)}</title></line>`;
  }).join("");
  const nodes = tasks.map((task) => {
    const point = positions.get(Number(task.id));
    const visited = traversalNodes.includes(Number(task.id)) ? "visited" : "";
    const statusClass = task.status === "Completed" ? "completed" : "pending";
    const isBlocked = task.status !== "Completed" && blockedTaskIds.has(Number(task.id));
    const displayStatus = isBlocked ? "Blocked" : task.status;
    return `<g class="graph-node ${statusClass} ${isBlocked ? "blocked" : ""} ${task.priority === "Critical" ? "critical" : ""} ${visited}">
      <circle cx="${point.x}" cy="${point.y}" r="28"></circle>
      <text x="${point.x}" y="${point.y - 2}">${escapeHTML(task.title.length > 18 ? `${task.title.slice(0, 16)}…` : task.title)}</text>
      <text x="${point.x}" y="${point.y + 42}" class="node-status">${displayStatus} · ${task.priority}</text>
      <title>${escapeHTML(task.title)}</title>
    </g>`;
  }).join("");
  $("dependency-svg").setAttribute("viewBox", `0 0 ${width} ${height}`);
  $("dependency-svg").innerHTML = `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#66708d"></path></marker></defs>${edges}${nodes}`;

  $("graph-summary").textContent = `${tasks.length} tasks · ${graphEdges.length} dependencies · ${blockedTaskIds.size} blocked`;
  $("dependency-list").innerHTML = graphEdges.map((edge) => `
    <div class="dependency-row">
      <span>${escapeHTML(edge.task_title)} depends on <strong>${escapeHTML(edge.dependency_title)}</strong></span>
      <button class="action-btn delete-btn" data-remove-edge="${edge.task_id}" data-prerequisite="${edge.dependency_id}">Remove</button>
    </div>
  `).join("") || '<div class="empty">No dependencies yet. Add one above to map your schedule.</div>';
}

async function traverseGraph(kind) {
  if (!tasks.length) {
    $("graph-status").textContent = "Add tasks first or load the sample workspace.";
    return;
  }
  const adjacency = graphAdjacency();
  const start = Number($("graph-start").value);
  const visited = new Set();
  const order = [];
  if (kind === "topological") {
    const indegree = new Map(tasks.map((task) => [Number(task.id), 0]));
    adjacency.forEach((neighbors) => neighbors.forEach((node) => indegree.set(node, indegree.get(node) + 1)));
    const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort((a, b) => a - b);
    while (ready.length) {
      const node = ready.shift();
      order.push(node);
      (adjacency.get(node) || []).forEach((neighbor) => {
        indegree.set(neighbor, indegree.get(neighbor) - 1);
        if (indegree.get(neighbor) === 0) ready.push(neighbor);
      });
    }
    if (order.length !== tasks.length) {
      $("graph-status").textContent = "Cycle detected. A safe topological schedule cannot be produced.";
      return;
    }
    traversalNodes = order;
    $("graph-status").textContent = `Valid schedule order: ${order.map((id) => tasks.find((task) => Number(task.id) === id).title).join(" → ")}`;
  } else if (kind === "bfs") {
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const node = queue.shift();
      order.push(node);
      (adjacency.get(node) || []).forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }
    traversalNodes = order;
    $("graph-status").textContent = `BFS order from selected task: ${order.map((id) => tasks.find((task) => Number(task.id) === id).title).join(" → ")}`;
  } else {
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      order.push(node);
      [...(adjacency.get(node) || [])].reverse().forEach((neighbor) => stack.push(neighbor));
    }
    traversalNodes = order;
    $("graph-status").textContent = `DFS order from selected task: ${order.map((id) => tasks.find((task) => Number(task.id) === id).title).join(" → ")}`;
  }
  renderGraph();
}

$("graph-add").addEventListener("click", async () => {
  try {
    await api("/api/dependencies", {
      method: "POST",
      body: JSON.stringify({ task_id: $("graph-task").value, dependency_id: $("graph-dependency").value }),
    });
    traversalNodes = [];
    await loadGraph();
    notify("Dependency added. Prerequisite relationship saved.");
  } catch (error) {
    $("graph-status").textContent = error.message;
    notify(error.message);
  }
});
$("dependency-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-edge]");
  if (!button) return;
  try {
    await api(`/api/dependencies/${button.dataset.removeEdge}/${button.dataset.prerequisite}`, { method: "DELETE" });
    await loadGraph();
    notify("Dependency removed.");
  } catch (error) {
    notify(error.message);
  }
});
$("graph-bfs").addEventListener("click", () => traverseGraph("bfs"));
$("graph-dfs").addEventListener("click", () => traverseGraph("dfs"));
$("graph-topo").addEventListener("click", () => traverseGraph("topological"));

$("sample-data").addEventListener("click", async () => {
  if (!window.confirm("Add realistic sample records until the workspace has 70 tasks? Existing tasks are kept.")) return;
  try {
    const result = await api("/api/demo-data", { method: "POST", body: JSON.stringify({}) });
    await loadDashboard();
    notify(result.message);
    switchPage("dashboard");
  } catch (error) {
    notify(error.message);
  }
});

loadDashboard();
