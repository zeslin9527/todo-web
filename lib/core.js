/* web/lib/core.js — pure helpers shared between the PWA and node tests.
 * UMD-style: attaches window.TodoCore in the browser, module.exports in node.
 * Keep this file dependency-free and DOM-free so `require()` works in tests.
 * Status semantics intentionally mirror src/todo-md.js so a future merge is easy.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.TodoCore = mod;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const TITLE = '# 待办';
  const DEFAULT_CATEGORY = '收件箱';
  const DEFAULT_MODEL = 'doubao-seed-2-1-lite-260915';
  const DEFAULT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

  // Same marker table as src/todo-md.js.
  const MARKERS = {
    ' ': 'todo',
    x: 'completed',
    X: 'completed',
    '>': 'todo',
    '-': 'cancelled',
  };
  const STATUS_MARKERS = {
    todo: '[ ]',
    completed: '[x]',
    cancelled: '[-]',
  };

  /* ---------- AI split ---------- */

  // Robustly pull a JSON array [{text, category}] out of raw LLM output.
  // Tries JSON.parse first, then extracts the first [...] slice (models love
  // wrapping answers in prose or ```json fences). Items without a non-empty
  // string `text` are dropped; `category` falls back to DEFAULT_CATEGORY.
  function parseSplitResponse(raw) {
    if (raw == null) return [];
    let parsed = null;
    const text = String(raw).trim();
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const m = /\[[\s\S]*\]/.exec(text);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch (e2) {
          parsed = null;
        }
      }
    }
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const it of parsed) {
      if (!it || typeof it !== 'object') continue;
      const t = typeof it.text === 'string' ? it.text.trim() : '';
      if (!t) continue;
      const c = typeof it.category === 'string' && it.category.trim()
        ? it.category.trim()
        : DEFAULT_CATEGORY;
      out.push({ text: t, category: c });
    }
    return out;
  }

  // Returns the system+user messages for the chat/completions call. The model
  // must answer with ONLY a JSON array of {text, category}.
  function buildSplitPrompt(transcript, categories) {
    const cats = Array.isArray(categories) ? categories.filter(Boolean) : [];
    const system =
      '你是一个待办事项整理助手。用户会给你一段语音转写文字，' +
      '请把它拆分成若干条具体、可执行的待办事项。' +
      '每条事项选择一个最合适的分类：优先从已有分类中选择，' +
      '都不合适时给出一个简短的新分类名（2-6个字）。' +
      '只回答一个 JSON 数组，形如 [{"text":"...","category":"..."}]，' +
      '不要输出任何其他文字、解释或代码块标记。';
    const user =
      `已有分类：${cats.length ? cats.join('、') : '（无）'}\n` +
      `语音转写：${String(transcript || '').trim()}\n` +
      '请输出 JSON 数组。';
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  /* ---------- markdown (mirrors src/todo-md.js) ---------- */

  // Serialize { categories: [{name, items:[{text,status}]}] } to the same
  // `## cat` + `- [ ]/- [x]/- [-]` format as the desktop todo.md.
  function todosToMarkdown(data) {
    const lines = [TITLE, ''];
    const cats = (data && data.categories) || [];
    cats.forEach((cat, i) => {
      if (i > 0) lines.push('');
      lines.push(`## ${cat.name}`);
      for (const item of cat.items) {
        lines.push(`- ${STATUS_MARKERS[item.status] || '[ ]'} ${item.text}`);
      }
    });
    return lines.join('\n') + '\n';
  }

  // Inverse of todosToMarkdown; same parsing rules as src/todo-md.js#parse,
  // including: unknown lines ignored, [>] read as todo, items before the first
  // `##` fall into DEFAULT_CATEGORY. ids are assigned as `c{cat}-{item}`.
  function markdownToTodos(text) {
    const categories = [];
    const byName = new Map();

    function category(name) {
      let cat = byName.get(name);
      if (!cat) {
        cat = { name, items: [] };
        byName.set(name, cat);
        categories.push(cat);
      }
      return cat;
    }

    let current = null;
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const catMatch = /^##\s+(.+?)\s*$/.exec(line);
      if (catMatch) {
        current = category(catMatch[1]);
        continue;
      }
      const itemMatch = /^- \[([ xX>\-])\]\s*(.*)$/.exec(line.trim());
      if (itemMatch) {
        const cat = current || category(DEFAULT_CATEGORY);
        cat.items.push({
          id: '',
          text: itemMatch[2],
          status: MARKERS[itemMatch[1]],
        });
      }
    }

    categories.forEach((cat, ci) => {
      cat.items.forEach((item, ii) => {
        item.id = `c${ci}-${ii}`;
      });
    });

    return { categories };
  }

  return {
    TITLE,
    DEFAULT_CATEGORY,
    DEFAULT_MODEL,
    DEFAULT_ENDPOINT,
    MARKERS,
    STATUS_MARKERS,
    parseSplitResponse,
    buildSplitPrompt,
    todosToMarkdown,
    markdownToTodos,
  };
});
