import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  FileText,
  FlaskConical,
  GitPullRequest,
  ListFilter,
  Menu,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import {
  makeDraft,
  seedTasks,
  nextTime,
  visibleTasks,
  validateDraft,
} from "./model.mjs";
import { copy, templates } from "./copy.mjs";

function IconButton({ icon: Icon, label, onClick, ...props }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      {...props}
    >
      <Icon size={18} strokeWidth={1.7} />
    </button>
  );
}
function scheduleLabel(rule, t) {
  if (rule.kind === "every") return t.everyN(rule.minutes);
  if (rule.kind === "daily") return `${t.daily} ${rule.time}`;
  if (rule.kind === "weekly")
    return `${t.weekdays[Number(rule.weekday)]} ${rule.time}`;
  return t.once;
}
function nextLabel(at, lang, t) {
  const date = new Date(at),
    today = new Date();
  const time = date.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${format.format(date) === format.format(today) ? t.today : date.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { timeZone: "Asia/Shanghai", month: "short", day: "numeric" })} ${time}`;
}
function ScheduleFields({ draft, setDraft, t }) {
  const change = (key, value) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <>
      <div className="field">
        <label htmlFor="rule">{t.schedule}</label>
        <div className="rule-fields">
          <select
            id="rule"
            value={draft.kind}
            onChange={(event) => change("kind", event.target.value)}
          >
            <option value="every">{t.every}</option>
            <option value="daily">{t.daily}</option>
            <option value="weekly">{t.weekly}</option>
            <option value="once">{t.once}</option>
          </select>
          {draft.kind === "every" ? (
            <label className="inline-field">
              <input
                aria-label={t.interval}
                type="number"
                min="5"
                max="525600"
                value={draft.minutes}
                onChange={(event) => change("minutes", event.target.value)}
              />
              <span>{t.minutes}</span>
            </label>
          ) : (
            <>
              {draft.kind === "weekly" && (
                <select
                  aria-label={t.weekday}
                  value={draft.weekday}
                  onChange={(event) => change("weekday", event.target.value)}
                >
                  {t.weekdays.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              )}
              <input
                aria-label={t.time}
                type={draft.kind === "once" ? "datetime-local" : "time"}
                value={draft.kind === "once" ? draft.at : draft.time}
                onInput={(event) =>
                  change(
                    draft.kind === "once" ? "at" : "time",
                    event.currentTarget.value,
                  )
                }
              />
            </>
          )}
        </div>
        <p className="field-note">
          {draft.kind === "every" ? t.minimum : `${t.timezone} · Asia/Shanghai`}
        </p>
      </div>
      <details className="advanced">
        <summary>
          {t.advanced}
          <ChevronDown size={14} />
        </summary>
        <div className="advanced-fields">
          <div className="field">
            <label htmlFor="workspace">{t.workspace}</label>
            <select
              id="workspace"
              value={draft.workspace}
              onChange={(event) => change("workspace", event.target.value)}
            >
              <option value="x-harness-rs">x-harness-rs</option>
              <option value="training">training</option>
              <option value="research">research</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="runner">{t.runner}</label>
            <select
              id="runner"
              value={draft.runner}
              onChange={(event) => change("runner", event.target.value)}
            >
              <option value="local">{t.local}</option>
              <option value="server">{t.server}</option>
            </select>
          </div>
        </div>
        <p className="field-note">{t.modelNote}</p>
      </details>
    </>
  );
}
function Editor({ initial, editing, onCancel, onSave, t, lang }) {
  const [draft, setDraft] = useState(initial),
    [review, setReview] = useState(false),
    [error, setError] = useState("");
  const submit = (event) => {
    event.preventDefault();
    const issue = validateDraft(draft);
    if (issue) {
      setError(t.errors[issue]);
      return;
    }
    setError("");
    setReview(true);
  };
  return (
    <section className="editor content-column">
      <button className="back-button" onClick={onCancel}>
        <ArrowLeft size={17} />
        {t.back}
      </button>
      <h1>{review ? t.confirm : editing ? t.edit : t.newTask}</h1>
      <p className="subtitle">{review ? t.reviewHelp : t.editorHelp}</p>
      {!review ? (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="task-title">{t.taskTitle}</label>
            <input
              id="task-title"
              autoFocus
              maxLength={100}
              placeholder={t.titlePlaceholder}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="task-prompt">{t.instruction}</label>
            <textarea
              id="task-prompt"
              rows={5}
              maxLength={5000}
              placeholder={t.promptPlaceholder}
              value={draft.prompt}
              onChange={(event) =>
                setDraft({ ...draft, prompt: event.target.value })
              }
            />
          </div>
          <ScheduleFields draft={draft} setDraft={setDraft} t={t} />
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onCancel}
            >
              {t.cancel}
            </button>
            <button className="primary-button">
              {t.next}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="review-card">
            <h2>{draft.title.trim()}</h2>
            <p className="review-prompt">{draft.prompt.trim()}</p>
            <dl>
              <div>
                <dt>{t.schedule}</dt>
                <dd>{scheduleLabel(draft, t)}</dd>
              </div>
              <div>
                <dt>{t.workspace}</dt>
                <dd>{draft.workspace}</dd>
              </div>
              <div>
                <dt>{t.runner}</dt>
                <dd>{draft.runner === "server" ? t.server : t.local}</dd>
              </div>
              <div>
                <dt>{t.nextRun}</dt>
                <dd>{nextLabel(nextTime(draft), lang, t)}</dd>
              </div>
            </dl>
          </div>
          <p className="preview-note">
            <Clock3 size={15} />
            {t.confirmNote}
          </p>
          <div className="form-actions">
            <button
              className="secondary-button"
              onClick={() => setReview(false)}
            >
              {t.modify}
            </button>
            <button className="primary-button" onClick={() => onSave(draft)}>
              <Check size={16} />
              {editing ? t.savePreview : t.createPreview}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function TaskDetail({
  task,
  t,
  lang,
  onBack,
  onEdit,
  onToggle,
  onRun,
  onDelete,
}) {
  const [menu, setMenu] = useState(false),
    [tab, setTab] = useState("history");
  useEffect(() => {
    if (!menu) return;
    const close = (event) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  return (
    <section className="detail">
      <header className="detail-header">
        <div className="detail-title">
          <button
            className="mobile-back icon-button"
            aria-label={t.back}
            onClick={onBack}
          >
            <ArrowLeft size={18} />
          </button>
          <h1>{task.title}</h1>
        </div>
        <div className="detail-actions">
          <button
            role="switch"
            aria-checked={task.enabled}
            aria-label={t.enabled}
            className="status-toggle"
            onClick={onToggle}
          >
            {task.enabled ? t.enabled : t.paused}
            <span className="switch-track">
              <span />
            </span>
          </button>
          <div className="popover-anchor">
            <IconButton
              icon={MoreHorizontal}
              label={t.more}
              onClick={() => setMenu(!menu)}
              aria-expanded={menu}
            />
            {menu && (
              <>
                <button
                  className="menu-scrim"
                  aria-label={t.closeMenu}
                  onClick={() => setMenu(false)}
                />
                <div className="popover" role="menu">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onEdit();
                    }}
                  >
                    {t.edit}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onRun();
                    }}
                  >
                    {t.runDemo}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onDelete();
                    }}
                  >
                    {t.deleteTask}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="detail-meta">
        <button onClick={onEdit}>
          <Clock3 size={15} />
          {scheduleLabel(task, t)}
          <ChevronDown size={14} />
        </button>
        <span>
          {task.enabled
            ? `${t.nextRun} ${nextLabel(task.nextAt, lang, t)}`
            : t.noNext}
        </span>
      </div>
      <div className="detail-tabs" role="tablist" aria-label={t.taskView}>
        {["history", "instruction"].map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            id={`tab-${value}`}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                event.preventDefault();
                const next = value === "history" ? "instruction" : "history";
                setTab(next);
                event.currentTarget.parentElement
                  .querySelector(`#tab-${next}`)
                  ?.focus();
              }
            }}
            tabIndex={tab === value ? 0 : -1}
          >
            {value === "history" ? t.history : t.instruction}
          </button>
        ))}
      </div>
      <div className="detail-scroll">
        <div className="content-column">
          {tab === "instruction" ? (
            <div
              id="panel-instruction"
              role="tabpanel"
              aria-labelledby="tab-instruction"
              tabIndex={0}
              className="instruction-panel"
            >
              <p>{task.prompt}</p>
              <dl>
                <div>
                  <dt>{t.workspace}</dt>
                  <dd>{task.workspace}</dd>
                </div>
                <div>
                  <dt>{t.runner}</dt>
                  <dd>{task.runner === "server" ? t.server : t.local}</dd>
                </div>
              </dl>
              <button className="secondary-button" onClick={onEdit}>
                {t.edit}
              </button>
            </div>
          ) : (
            <div
              id="panel-history"
              role="tabpanel"
              aria-labelledby="tab-history"
              tabIndex={0}
            >
              <div className="history-caption">
                <span>{t.sampleHistory}</span>
                <button className="text-button" onClick={onRun}>
                  {t.runDemo}
                  <ArrowRight size={14} />
                </button>
              </div>
              {task.runs.length === 0 ? (
                <div className="empty-history">
                  <Clock3 size={28} />
                  <h2>{t.notRun}</h2>
                  <p>{t.notRunHelp}</p>
                </div>
              ) : (
                task.runs.map((run) => (
                  <article className="run" key={run.id}>
                    <div className="run-header">
                      <time>{run.demoNow ? t.justNow : t.sampleTime}</time>
                      <span>{t.sample}</span>
                    </div>
                    <details className="worked">
                      <summary>
                        {t.worked(run.seconds)}
                        <ChevronDown size={15} />
                      </summary>
                      <p>{t.sampleProcess}</p>
                    </details>
                    <h2>{run.demoNow ? t.demoResult : t.seedResult}</h2>
                    <p>{run.demoNow ? t.demoBody : t.seedBody}</p>
                    {!run.demoNow && (
                      <ul>
                        <li>{t.seedPoint1}</li>
                        <li>{t.seedPoint2}</li>
                      </ul>
                    )}
                    <div className="result-note">{t.resultNote}</div>
                  </article>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="detail-footer">
        <Server size={14} />
        {t.offlineNote}
      </footer>
    </section>
  );
}
function DeleteDialog({ task, t, onCancel, onConfirm }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      onCancel={onCancel}
      onClick={(event) => {
        if (event.target === ref.current) onCancel();
      }}
      aria-labelledby="delete-title"
    >
      <h2 id="delete-title">{t.deleteTitle}</h2>
      <p>{t.deleteHelp(task.title)}</p>
      <div className="form-actions">
        <button autoFocus className="secondary-button" onClick={onCancel}>
          {t.cancel}
        </button>
        <button className="primary-button" onClick={onConfirm}>
          {t.deletePreview}
        </button>
      </div>
    </dialog>
  );
}
export function App() {
  const [lang, setLang] = useState("zh"),
    [dark, setDark] = useState(false),
    [tasks, setTasks] = useState(seedTasks),
    [view, setView] = useState({ type: "home" });
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [filterOpen, setFilterOpen] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [mobileList, setMobileList] = useState(false),
    [toast, setToast] = useState(""),
    [deleting, setDeleting] = useState(null);
  const [compact, setCompact] = useState(
      () => window.matchMedia("(max-width:620px)").matches,
    ),
    sidebarRef = useRef(null),
    drawerTrigger = useRef(null);
  const t = copy[lang],
    task = tasks.find((item) => item.id === view.id);
  useEffect(() => {
    const media = window.matchMedia("(max-width:620px)");
    const changed = () => {
      setCompact(media.matches);
      if (!media.matches) setMobileList(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!compact || !mobileList) return;
    drawerTrigger.current = document.activeElement;
    sidebarRef.current?.querySelector(".drawer-close")?.focus();
    return () => drawerTrigger.current?.focus();
  }, [compact, mobileList]);
  useEffect(() => {
    const close = (event) => {
      if (event.key === "Escape") {
        setFilterOpen(false);
        setMobileList(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.title = `XHarness · ${t.scheduled}`;
  }, [lang, dark, t]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = (next) => {
    setView(next);
    setMobileList(false);
    setFilterOpen(false);
  };
  const openEditor = (template) =>
    navigate({
      type: "editor",
      nonce: crypto.randomUUID(),
      draft: makeDraft(template, lang),
    });
  const save = (draft) => {
    const title = draft.title.trim(),
      prompt = draft.prompt.trim();
    if (view.editing) {
      setTasks((current) =>
        current.map((item) =>
          item.id === view.id
            ? { ...item, ...draft, title, prompt, nextAt: nextTime(draft) }
            : item,
        ),
      );
      navigate({ type: "detail", id: view.id });
    } else {
      const id = crypto.randomUUID();
      setTasks((current) => [
        ...current,
        {
          ...draft,
          id,
          title,
          prompt,
          enabled: true,
          nextAt: nextTime(draft),
          runs: [],
        },
      ]);
      navigate({ type: "detail", id });
    }
    setToast(t.savedNote);
  };
  const shown = visibleTasks(tasks, { query, filter });
  return (
    <div className="app-shell">
      <aside
        ref={sidebarRef}
        className={`sidebar ${mobileList ? "is-open" : ""}`}
        aria-label={t.scheduled}
        aria-hidden={compact && !mobileList ? true : undefined}
        inert={compact && !mobileList ? true : undefined}
      >
        <div className="sidebar-heading">
          <button
            className="heading-button"
            onClick={() => navigate({ type: "home" })}
          >
            {t.scheduled}
          </button>
          <IconButton
            icon={Search}
            label={t.search}
            onClick={() => setSearchOpen(!searchOpen)}
            aria-expanded={searchOpen}
          />
          {mobileList && (
            <button
              className="icon-button drawer-close"
              aria-label={t.closeList}
              onClick={() => setMobileList(false)}
            >
              <X size={18} />
            </button>
          )}
        </div>
        {searchOpen && (
          <div className="search-field">
            <Search size={15} />
            <input
              autoFocus
              aria-label={t.search}
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
            />
            {query && (
              <IconButton
                icon={X}
                label={t.clearSearch}
                onClick={() => setQuery("")}
              />
            )}
          </div>
        )}
        <button
          className={`new-task ${view.type === "editor" && !view.editing ? "selected" : ""}`}
          onClick={() => openEditor()}
        >
          <Plus size={19} strokeWidth={1.5} />
          {t.newTask}
        </button>
        <div className="section-heading">
          <span>{filter === "paused" ? t.paused : t.upcoming}</span>
          <div className="popover-anchor">
            <IconButton
              icon={ListFilter}
              label={t.filter}
              onClick={() => setFilterOpen(!filterOpen)}
              aria-expanded={filterOpen}
            />
            {filterOpen && (
              <>
                <button
                  className="menu-scrim"
                  aria-label={t.closeMenu}
                  onClick={() => setFilterOpen(false)}
                />
                <div className="popover filter-popover" role="menu">
                  {["all", "enabled", "paused"].map((value) => (
                    <button
                      role="menuitemradio"
                      aria-checked={filter === value}
                      key={value}
                      onClick={() => {
                        setFilter(value);
                        setFilterOpen(false);
                      }}
                    >
                      {t[value]}
                      {filter === value && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <nav className="task-list" aria-label={t.taskList}>
          {(expanded ? shown : shown.slice(0, 5)).map((item) => (
            <button
              key={item.id}
              className={`task-row ${view.id === item.id ? "selected" : ""}`}
              aria-current={view.id === item.id ? "page" : undefined}
              onClick={() => navigate({ type: "detail", id: item.id })}
            >
              <span className="task-name">{item.title}</span>
              <span className="task-time">
                {item.enabled
                  ? `${nextLabel(item.nextAt, lang, t)} · ${scheduleLabel(item, t)}`
                  : t.paused}
              </span>
            </button>
          ))}
          {shown.length === 0 && (
            <p className="no-tasks">{query ? t.noMatches : t.noTasks}</p>
          )}
          {shown.length > 5 && (
            <button
              className="show-more"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t.showLess : t.showMore}
            </button>
          )}
        </nav>
        <footer className="sidebar-footer">
          <p>{t.previewLabel}</p>
          <div>
            <span>{t.memoryOnly}</span>
            <button
              className="language-button"
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
              aria-label={t.switchLanguage}
            >
              {lang === "zh" ? "EN" : "中文"}
            </button>
            <IconButton
              icon={dark ? Sun : Moon}
              label={dark ? t.light : t.dark}
              onClick={() => setDark(!dark)}
            />
          </div>
        </footer>
      </aside>
      {mobileList && (
        <button
          className="sidebar-scrim"
          aria-label={t.closeList}
          onClick={() => setMobileList(false)}
        />
      )}
      <main
        className="main-workspace"
        inert={compact && mobileList ? true : undefined}
      >
        <header className="mobile-toolbar">
          <IconButton
            icon={Menu}
            label={t.openList}
            onClick={() => setMobileList(!mobileList)}
          />
          <span>{t.scheduled}</span>
          <IconButton
            icon={Plus}
            label={t.newTask}
            onClick={() => openEditor()}
          />
        </header>
        {view.type === "home" && (
          <div className="home">
            <div className="home-content">
              <div className="intro">
                <Clock3 className="hero-clock" size={48} strokeWidth={1.25} />
                <h1>{t.homeTitle}</h1>
                <p>{t.homeHelp}</p>
              </div>
              <div className="template-grid">
                {templates[lang].map((template, index) => {
                  const Icon = [
                    GitPullRequest,
                    Terminal,
                    FlaskConical,
                    FileText,
                    Code2,
                    Server,
                  ][index];
                  return (
                    <button
                      key={template.title}
                      className="template-card"
                      onClick={() => openEditor(template)}
                    >
                      <Icon size={26} strokeWidth={1.5} />
                      <div>
                        <h2>{template.title}</h2>
                        <p>{template.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {view.type === "editor" && (
          <Editor
            key={`${view.id ?? "new"}-${view.nonce ?? ""}`}
            initial={view.draft}
            editing={view.editing}
            onCancel={() =>
              navigate(
                view.editing
                  ? { type: "detail", id: view.id }
                  : { type: "home" },
              )
            }
            onSave={save}
            t={t}
            lang={lang}
          />
        )}
        {view.type === "detail" && task && (
          <TaskDetail
            key={task.id}
            task={task}
            t={t}
            lang={lang}
            onBack={() => navigate({ type: "home" })}
            onEdit={() =>
              navigate({
                type: "editor",
                id: task.id,
                editing: true,
                draft: { ...task },
              })
            }
            onToggle={() => {
              setTasks((current) =>
                current.map((item) =>
                  item.id === task.id
                    ? { ...item, enabled: !item.enabled }
                    : item,
                ),
              );
              setToast(t.toggleNote);
            }}
            onRun={() => {
              setTasks((current) =>
                current.map((item) =>
                  item.id === task.id
                    ? {
                        ...item,
                        runs: [
                          {
                            id: crypto.randomUUID(),
                            demoNow: true,
                            seconds: 0,
                          },
                          ...item.runs,
                        ],
                      }
                    : item,
                ),
              );
              setToast(t.runNote);
            }}
            onDelete={() => setDeleting(task)}
          />
        )}
      </main>
      {deleting && (
        <DeleteDialog
          task={deleting}
          t={t}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setTasks((current) =>
              current.filter((item) => item.id !== deleting.id),
            );
            setDeleting(null);
            navigate({ type: "home" });
            setToast(t.deletedNote);
          }}
        />
      )}
      <div
        className={`toast ${toast ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {toast}
      </div>
    </div>
  );
}
