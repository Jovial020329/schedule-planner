/**
 * Schedule Planner Extension - 日程规划扩展
 * 双分支：个人日程 + 世界事件
 * 多角色日程列表，支持交叉注入
 */

const MODULE_NAME = 'schedule_planner';
const DEBUG_PREFIX = '[SchedulePlanner]';

// ==================== Default Prompts ====================

const DEFAULT_PERSONAL_SYS = `你是一个出色的剧情日程规划师。请为【{{targetChar}}】规划从当前剧情时间点开始的未来{{numDays}}天个人日程安排。

规划要求：
- 基于当前剧情发展、角色性格、人物关系来安排合理且有趣的日程
- 每天安排 2~5 个事件，事件要有具体的起止时间（如 14:00-15:30）和地点
- 每个事件需要标题和概述，概述应当详细描写该时间段内发生的具体情景（50-100字）
- 事件应体现角色的个人特征、日常习惯、社交关系
- 可自由发挥，不必拘泥于已有设定
{{charCard}}
{{userPersona}}
{{worldbook}}
{{otherSchedules}}
{{globalGuide}}

输出要求：只输出JSON数组，禁止包含任何额外前缀、Markdown标识或解释文字。
JSON格式：
[
  {
    "day": "第1天 X月X日（星期X）",
    "events": [
      {
        "time": "09:00-11:00",
        "title": "事件标题（标签｜重要程度）",
        "location": "具体地点",
        "summary": "详细概述该时间段发生了什么..."
      }
    ]
  }
]`;

const DEFAULT_PERSONAL_USER = `以下是近期剧情记录：
{{context}}

请为【{{targetChar}}】生成未来{{numDays}}天的个人日程安排。严格按纯JSON数组输出。`;

const DEFAULT_WORLD_SYS = `你是一个世界观构建师。请为【{{targetChar}}】规划未来{{numDays}}天内将要发生的世界事件。

规划要求：
- 这些是发生在世界中的公共事件、社会动态、环境变化等，不针对某个特定角色
- 事件类型可包括：城市日常、社会新闻、天气/自然现象、政治/经济动态、突发事件、节日/活动等
- 每天安排 1~4 个世界事件，有具体时间和地点
- 每个事件需要标题（含标签和重要程度）和详细概述（50-150字）
- 概述应当像新闻报道或场景描写一样生动具体
{{charCard}}
{{worldbook}}
{{otherSchedules}}
{{globalGuide}}

输出要求：只输出JSON数组，禁止包含任何额外前缀、Markdown标识或解释文字。
JSON格式：
[
  {
    "day": "第1天 X月X日（星期X）",
    "events": [
      {
        "time": "20:30-22:00",
        "title": "事件标题（标签｜重要程度）",
        "location": "具体地点",
        "summary": "详细概述..."
      }
    ]
  }
]`;

const DEFAULT_WORLD_USER = `以下是近期剧情记录：
{{context}}

请为【{{targetChar}}】生成未来{{numDays}}天的世界事件。严格按纯JSON数组输出。`;

// ==================== Default Settings ====================

const defaultSettings = {
    // 共享 API 配置
    apiMode: 'st',
    customApiUrl: '',
    customApiKey: '',
    customModel: '',

    // 个人日程分支
    personal: {
        targetCharName: '',
        globalGuide: '',
        numDays: 7,
        numContextMessages: 20,
        injectCharCard: true,
        injectUserPersona: false,
        injectWorldBook: false,
        injectOtherSchedules: false,
        worldbookSelections: {},
        systemPrompt: '',
        userPrompt: '',
    },

    // 世界事件分支
    world: {
        targetWorldName: '',
        globalGuide: '',
        numDays: 7,
        numContextMessages: 20,
        injectCharCard: false,
        injectWorldBook: false,
        injectOtherSchedules: false,
        worldbookSelections: {},
        systemPrompt: '',
        userPrompt: '',
    },

    // 已生成的日程列表: [ { name, branch, schedule, injecting } ]
    activeSchedules: [],
};

// ==================== Runtime State ====================

let isGenerating = false;
let loadedWorldbookData = {};
let currentBranch = 'personal';
let currentPreviewIdx = -1; // 当前预览的 activeSchedules 索引，-1=收起

// ==================== Helpers ====================

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    var ctx = getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    var s = ctx.extensionSettings[MODULE_NAME];
    for (var key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    for (var bk of ['personal', 'world']) {
        if (!s[bk] || typeof s[bk] !== 'object') {
            s[bk] = structuredClone(defaultSettings[bk]);
        }
        for (var k of Object.keys(defaultSettings[bk])) {
            if (s[bk][k] === undefined) s[bk][k] = defaultSettings[bk][k];
        }
    }
    if (!Array.isArray(s.activeSchedules)) s.activeSchedules = [];
    return s;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function getBranchSettings(branch) {
    return getSettings()[branch || currentBranch];
}

function getTargetCharName() {
    var bs = getBranchSettings('personal');
    if (bs.targetCharName && bs.targetCharName.trim()) return bs.targetCharName.trim();
    return getCurrentCharName();
}

function getCurrentCharName() {
    var ctx = getContext();
    if (ctx.characters && ctx.characters[ctx.characterId]) {
        return ctx.characters[ctx.characterId].name || '角色';
    }
    return '角色';
}

function getTargetWorldName() {
    var bs = getBranchSettings('world');
    if (bs.targetWorldName && bs.targetWorldName.trim()) return bs.targetWorldName.trim();
    return getCurrentCharName() + '的世界事件';
}

function getWorldbookSelectionKey(branch) {
    return branch === 'personal' ? getTargetCharName() : getTargetWorldName();
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== Data Gathering ====================

function getCharCardText() {
    var ctx = getContext();
    var charId = ctx.characterId;
    if (charId === undefined || !ctx.characters || !ctx.characters[charId]) return '';
    var char = ctx.characters[charId];
    var parts = [];
    if (char.description) parts.push('角色描述: ' + char.description);
    if (char.personality) parts.push('性格: ' + char.personality);
    if (char.scenario) parts.push('场景: ' + char.scenario);
    return parts.join('\n');
}

function getUserPersonaText() {
    var ctx = getContext();
    if (ctx.persona) return ctx.persona;
    if (ctx.name1) return '用户名: ' + ctx.name1;
    return '';
}

function getContextMessages(count) {
    var ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) return '';
    var messages = ctx.chat.slice(-count);
    return messages.map(function(msg) {
        var name = msg.is_user ? '<user>' : (msg.name || '<char>');
        return name + ': ' + (msg.mes || '');
    }).join('\n');
}

function getOtherSchedulesText(excludeName) {
    var settings = getSettings();
    var parts = [];
    for (var item of settings.activeSchedules) {
        if (item.name === excludeName) continue;
        var text = buildInjectionTextForSchedule(item.name, item.schedule);
        if (text) parts.push(text);
    }
    return parts.join('\n\n');
}

async function getSelectedWorldbookContent(branch) {
    var bs = getBranchSettings(branch);
    var key = getWorldbookSelectionKey(branch);
    var selections = bs.worldbookSelections[key];
    if (!selections && branch === 'world') selections = bs.worldbookSelections._world_;
    if (!selections) return '';
    var parts = [];
    for (var bookName of Object.keys(selections)) {
        var uids = selections[bookName];
        if (!uids || uids.length === 0) continue;
        var entries = loadedWorldbookData[bookName];
        if (!entries) {
            try { entries = await loadWorldbookEntries(bookName); }
            catch (e) { continue; }
        }
        if (!entries) continue;
        for (var entry of entries) {
            var uid = String(entry.uid !== undefined ? entry.uid : entry.id);
            if (uids.includes(uid)) {
                var title = entry.comment || entry.key || ('条目' + uid);
                parts.push('[' + title + '] ' + (entry.content || ''));
            }
        }
    }
    return parts.join('\n');
}

// ==================== Worldbook Loading ====================

async function loadAllWorldbookNames() {
    var allBooks = [];
    var TavernHelper = window.TavernHelper ||
        (typeof window.parent !== 'undefined' ? window.parent.TavernHelper : null);
    if (TavernHelper && TavernHelper.getCharLorebooks) {
        try {
            var lorebooks = await TavernHelper.getCharLorebooks({ type: 'all' });
            if (lorebooks) {
                if (lorebooks.primary) allBooks.push(lorebooks.primary);
                if (lorebooks.additional && lorebooks.additional.length > 0)
                    allBooks = allBooks.concat(lorebooks.additional);
            }
        } catch (e) { console.warn(DEBUG_PREFIX, 'getCharLorebooks failed:', e); }
    }
    try {
        var ctx = getContext();
        var headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
        var listResp = await fetch('/api/worldinfo/list', { method: 'POST', headers: headers });
        if (listResp.ok) {
            var listData = await listResp.json();
            var worldNames = Array.isArray(listData) ? listData : (listData.entries || listData.world_names || []);
            try {
                var stWindow = window.parent || window;
                if (stWindow.selected_world_info) {
                    var globalNames = Array.isArray(stWindow.selected_world_info)
                        ? stWindow.selected_world_info : [stWindow.selected_world_info];
                    for (var gn of globalNames) {
                        if (gn && !allBooks.includes(gn)) allBooks.push(gn);
                    }
                }
            } catch (e) { /* ignore */ }
            if (allBooks.length === 0 && worldNames.length > 0) {
                for (var wn of worldNames) {
                    var name = String(wn).replace(/\.json$/i, '');
                    if (name && !allBooks.includes(name)) allBooks.push(name);
                }
            }
        }
    } catch (e) { console.warn(DEBUG_PREFIX, 'Failed to fetch worldinfo list:', e); }
    return allBooks;
}

async function loadWorldbookEntries(bookName) {
    var TavernHelper = window.TavernHelper ||
        (typeof window.parent !== 'undefined' ? window.parent.TavernHelper : null);
    if (TavernHelper && TavernHelper.getLorebookEntries) {
        try {
            var entries = await TavernHelper.getLorebookEntries(bookName);
            if (entries && entries.length > 0) { loadedWorldbookData[bookName] = entries; return entries; }
        } catch (e) { console.warn(DEBUG_PREFIX, 'TavernHelper failed for', bookName, e); }
    }
    try {
        var ctx = getContext();
        var headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
        var resp = await fetch('/api/worldinfo/get', {
            method: 'POST', headers: headers, body: JSON.stringify({ name: bookName }),
        });
        if (resp.ok) {
            var data = await resp.json();
            var entries = [];
            if (data && data.entries) {
                if (Array.isArray(data.entries)) { entries = data.entries; }
                else {
                    for (var uid of Object.keys(data.entries)) {
                        var entry = data.entries[uid];
                        if (entry) { if (entry.uid === undefined) entry.uid = uid; entries.push(entry); }
                    }
                }
            }
            loadedWorldbookData[bookName] = entries;
            return entries;
        }
    } catch (e) { console.warn(DEBUG_PREFIX, 'API failed for', bookName, e); }
    return [];
}

// ==================== Fetch Models ====================

async function fetchModels() {
    var settings = getSettings();
    var url = settings.customApiUrl;
    if (!url) { toastr.warning('请先填写API地址'); return; }
    url = url.replace(/\/+$/, '');

    var btn = jQuery('#sp_fetch_models_btn');
    btn.prop('disabled', true).text('获取中...');

    try {
        var resp = await fetch(url + '/models', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + settings.customApiKey,
            },
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        var models = [];
        if (data && data.data && Array.isArray(data.data)) {
            models = data.data.map(function(m) { return m.id; });
        } else if (Array.isArray(data)) {
            models = data.map(function(m) { return typeof m === 'string' ? m : m.id; });
        }

        if (models.length === 0) {
            toastr.warning('未获取到模型列表');
            return;
        }

        // 显示下拉选择
        var selectHtml = '<select id="sp_model_select" style="width:100%;padding:4px 6px;font-size:0.85em;box-sizing:border-box;margin-top:4px;">';
        var currentModel = settings.customModel || '';
        for (var m of models) {
            var sel = m === currentModel ? ' selected' : '';
            selectHtml += '<option value="' + escapeHtml(m) + '"' + sel + '>' + escapeHtml(m) + '</option>';
        }
        selectHtml += '</select>';

        jQuery('#sp_model_select_area').html(selectHtml);
        jQuery('#sp_model_select').on('change', function() {
            var val = jQuery(this).val();
            jQuery('#sp_model').val(val);
            settings.customModel = val;
            saveSettings();
        });
        // 自动选第一个如果当前没设
        if (!currentModel && models.length > 0) {
            jQuery('#sp_model').val(models[0]);
            settings.customModel = models[0];
            saveSettings();
        }

        toastr.success('获取到 ' + models.length + ' 个模型');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Fetch models error:', err);
        toastr.error('获取模型失败: ' + err.message);
    } finally {
        btn.prop('disabled', false).text('获取模型');
    }
}

// ==================== Prompt Building ====================

function getDefaultSysPrompt(branch) {
    return branch === 'world' ? DEFAULT_WORLD_SYS : DEFAULT_PERSONAL_SYS;
}
function getDefaultUserPrompt(branch) {
    return branch === 'world' ? DEFAULT_WORLD_USER : DEFAULT_PERSONAL_USER;
}

async function buildPromptsForBranch(branch) {
    var bs = getBranchSettings(branch);
    var targetChar = branch === 'personal' ? getTargetCharName() : getTargetWorldName();
    var numDays = bs.numDays || 7;
    var contextText = getContextMessages(bs.numContextMessages || 20);

    var charCardText = '';
    if (bs.injectCharCard) {
        var cc = getCharCardText();
        if (cc) charCardText = '\n【角色卡信息】\n' + cc;
    }
    var userPersonaText = '';
    if (branch === 'personal' && bs.injectUserPersona) {
        var up = getUserPersonaText();
        if (up) userPersonaText = '\n【用户人设】\n' + up;
    }
    var globalGuideText = '';
    if (bs.globalGuide && bs.globalGuide.trim()) {
        globalGuideText = '\n【全局指导】\n' + bs.globalGuide.trim();
    }
    var wbText = '';
    if (bs.injectWorldBook) {
        var wbContent = await getSelectedWorldbookContent(branch);
        if (wbContent) wbText = '\n【世界书信息】\n' + wbContent;
    }
    var otherText = '';
    if (bs.injectOtherSchedules) {
        var excludeName = branch === 'personal' ? getTargetCharName() : getTargetWorldName();
        var ot = getOtherSchedulesText(excludeName);
        if (ot) otherText = '\n【其他已有日程参考】\n' + ot;
    }

    var sysTemplate = bs.systemPrompt && bs.systemPrompt.trim()
        ? bs.systemPrompt : getDefaultSysPrompt(branch);
    var userTemplate = bs.userPrompt && bs.userPrompt.trim()
        ? bs.userPrompt : getDefaultUserPrompt(branch);

    function replaceVars(text) {
        return text
            .replace(/\{\{targetChar\}\}/g, targetChar)
            .replace(/\{\{numDays\}\}/g, String(numDays))
            .replace(/\{\{context\}\}/g, contextText)
            .replace(/\{\{charCard\}\}/g, charCardText)
            .replace(/\{\{userPersona\}\}/g, userPersonaText)
            .replace(/\{\{globalGuide\}\}/g, globalGuideText)
            .replace(/\{\{worldbook\}\}/g, wbText)
            .replace(/\{\{otherSchedules\}\}/g, otherText);
    }
    return { system: replaceVars(sysTemplate), user: replaceVars(userTemplate) };
}

// ==================== API Calls ====================

async function generateSchedule() {
    if (isGenerating) return;
    var settings = getSettings();
    var branch = currentBranch;

    var scheduleName = branch === 'personal' ? getTargetCharName() : getTargetWorldName();

    isGenerating = true;
    var btn = jQuery('#sp_generate_btn');
    btn.prop('disabled', true).html('<span class="sp-loading"></span>生成中...');

    try {
        var prompts = await buildPromptsForBranch(branch);
        var text;

        if (settings.apiMode === 'custom' && settings.customApiUrl) {
            text = await callCustomAPI(prompts, settings);
        } else {
            var ctx = getContext();
            var fullPrompt = prompts.system + '\n\n' + prompts.user;
            text = await ctx.generateQuietPrompt({ quietPrompt: fullPrompt });
        }

        if (!text) { toastr.error('生成失败：未返回结果'); return; }

        var schedule = parseScheduleJSON(text);
        if (!schedule) {
            toastr.error('JSON解析失败，请检查控制台');
            console.error(DEBUG_PREFIX, 'Raw response:', text);
            return;
        }

        // 给每个事件加 enabled 标记（默认全部启用）
        for (var d of schedule) {
            if (d.events) {
                for (var ev of d.events) {
                    if (ev.enabled === undefined) ev.enabled = true;
                }
            }
        }

        // 添加或替换到 activeSchedules
        var existing = -1;
        for (var i = 0; i < settings.activeSchedules.length; i++) {
            if (settings.activeSchedules[i].name === scheduleName && settings.activeSchedules[i].branch === branch) {
                existing = i; break;
            }
        }

        var entry = { name: scheduleName, branch: branch, schedule: schedule, injecting: false };
        if (existing >= 0) {
            settings.activeSchedules[existing] = entry;
        } else {
            settings.activeSchedules.push(entry);
        }

        saveSettings();
        updateInjection();
        renderActiveList();
        renderStatus();
        // 找到刚保存的 idx 并预览
        var previewIdx = -1;
        for (var pi = 0; pi < settings.activeSchedules.length; pi++) {
            if (settings.activeSchedules[pi].name === scheduleName && settings.activeSchedules[pi].branch === branch) {
                previewIdx = pi; break;
            }
        }
        if (previewIdx >= 0) {
            currentPreviewIdx = previewIdx;
            renderSchedulePreview(previewIdx);
        }
        toastr.success(scheduleName + ' 的日程已生成！共' + schedule.length + '天，点击💤可注入AI');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Generation error:', err);
        toastr.error('生成失败: ' + err.message);
    } finally {
        isGenerating = false;
        btn.prop('disabled', false).html('📅 生成');
    }
}

async function callCustomAPI(prompts, settings) {
    var url = settings.customApiUrl.replace(/\/+$/, '');
    var response = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + settings.customApiKey,
        },
        body: JSON.stringify({
            model: settings.customModel || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: prompts.system },
                { role: 'user', content: prompts.user },
            ],
            max_tokens: 4096,
            temperature: 0.8,
        }),
    });
    if (!response.ok) {
        var errText = await response.text();
        throw new Error('API ' + response.status + ': ' + errText.substring(0, 200));
    }
    var data = await response.json();
    return data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
}

function parseScheduleJSON(text) {
    var cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    var startIdx = cleaned.indexOf('[');
    var endIdx = cleaned.lastIndexOf(']');
    if (startIdx >= 0 && endIdx > startIdx) cleaned = cleaned.substring(startIdx, endIdx + 1);
    try {
        var parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) return parsed;
    } catch (e) { console.error(DEBUG_PREFIX, 'JSON parse error:', e); }
    return null;
}

// ==================== Injection ====================

function buildInjectionTextForSchedule(name, schedule) {
    if (!schedule || schedule.length === 0) return '';
    var lines = ['[' + name + '的日程安排]'];
    var hasAny = false;
    for (var day of schedule) {
        if (!day.events) continue;
        var enabledEvts = day.events.filter(function(e) { return e.enabled !== false; });
        if (enabledEvts.length === 0) continue;
        hasAny = true;
        lines.push('');
        lines.push('▣ ' + (day.day || ''));
        for (var evt of enabledEvts) {
            lines.push('');
            lines.push(' - 时间：' + (evt.time || ''));
            lines.push(' - 事件：' + (evt.title || ''));
            lines.push(' - 地点：' + (evt.location || ''));
            lines.push(' - 概述：' + (evt.summary || ''));
        }
    }
    return hasAny ? lines.join('\n') : '';
}

function updateInjection() {
    var settings = getSettings();
    var ctx = getContext();
    var parts = [];
    for (var item of settings.activeSchedules) {
        if (item.injecting) {
            var text = buildInjectionTextForSchedule(item.name, item.schedule);
            if (text) parts.push(text);
        }
    }
    var combined = parts.join('\n\n');
    ctx.setExtensionPrompt(MODULE_NAME, combined, 1, 0);
    console.log(DEBUG_PREFIX, 'Injection updated:', parts.length, 'schedules,', combined.length, 'chars');
}

function toggleItemInjection(idx) {
    var settings = getSettings();
    if (idx < 0 || idx >= settings.activeSchedules.length) return;
    settings.activeSchedules[idx].injecting = !settings.activeSchedules[idx].injecting;
    saveSettings();
    updateInjection();
    renderActiveList();
    renderStatus();
}

function removeScheduleItem(idx) {
    var settings = getSettings();
    if (idx < 0 || idx >= settings.activeSchedules.length) return;
    var name = settings.activeSchedules[idx].name;
    settings.activeSchedules.splice(idx, 1);
    saveSettings();
    updateInjection();
    renderActiveList();
    renderStatus();
    toastr.info('已移除「' + name + '」的日程');
}

// ==================== Worldbook UI ====================

async function onLoadWorldbooks(branch) {
    branch = branch || currentBranch;
    var container = jQuery('#sp_' + branch + '_wb_container');
    container.html('<span style="font-size:0.8em;">加载中...</span>');
    try {
        var allBooks = await loadAllWorldbookNames();
        if (allBooks.length === 0) {
            container.html('<span style="font-size:0.8em;">未找到世界书</span>');
            return;
        }
        var html = '';
        for (var bookName of allBooks) {
            var entries = await loadWorldbookEntries(bookName);
            if (!entries || entries.length === 0) continue;
            html += '<div class="sp-wb-book-group">';
            html += '<div class="book-title">' + escapeHtml(bookName) + '</div>';
            for (var entry of entries) {
                var uid = String(entry.uid !== undefined ? entry.uid : entry.id);
                var title = entry.comment || (entry.key ? (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key) : '条目' + uid);
                var checked = isWbEntrySelected(branch, bookName, uid) ? 'checked' : '';
                html += '<div class="sp-wb-entry">'
                    + '<input type="checkbox" ' + checked + ' data-book="' + escapeHtml(bookName) + '" data-uid="' + uid + '" class="sp-wb-entry-cb">'
                    + '<label>' + escapeHtml(String(title)) + '</label>'
                    + '</div>';
            }
            html += '</div>';
        }
        container.html(html || '<span style="font-size:0.8em;">所有世界书均无条目</span>');
    } catch (err) {
        console.error(DEBUG_PREFIX, 'Load worldbooks error:', err);
        container.html('<span style="font-size:0.8em;color:#d9534f;">加载失败: ' + err.message + '</span>');
    }
}

function isWbEntrySelected(branch, bookName, uid) {
    var bs = getBranchSettings(branch);
    var key = getWorldbookSelectionKey(branch);
    var sel = bs.worldbookSelections[key];
    if (!sel && branch === 'world') sel = bs.worldbookSelections._world_;
    if (!sel || !sel[bookName]) return false;
    return sel[bookName].includes(String(uid));
}

function saveWbSelections(branch) {
    branch = branch || currentBranch;
    var bs = getBranchSettings(branch);
    var key = getWorldbookSelectionKey(branch);
    var selections = {};
    jQuery('#sp_' + branch + '_wb_container .sp-wb-entry-cb').each(function() {
        var book = jQuery(this).data('book');
        var uid = String(jQuery(this).data('uid'));
        if (!selections[book]) selections[book] = [];
        if (jQuery(this).is(':checked')) selections[book].push(uid);
    });
    bs.worldbookSelections[key] = selections;
    saveSettings();
    toastr.success('世界书选择已保存');
}

// ==================== Schedule Preview ====================

function togglePreview(idx) {
    if (currentPreviewIdx === idx) {
        // 再次点击同一个 → 收起
        currentPreviewIdx = -1;
        jQuery('#sp_schedule_area').html('');
    } else {
        currentPreviewIdx = idx;
        var settings = getSettings();
        var item = settings.activeSchedules[idx];
        if (item) renderSchedulePreview(idx);
    }
}

function renderSchedulePreview(idx) {
    var settings = getSettings();
    var item = settings.activeSchedules[idx];
    if (!item) return;
    var schedule = item.schedule;
    var name = item.name;
    var container = jQuery('#sp_schedule_area');
    if (!schedule || schedule.length === 0) { container.html(''); return; }

    var html = '<div style="font-size:0.82em;font-weight:bold;margin-bottom:6px;">预览：' + escapeHtml(name) + '</div>';
    for (var di = 0; di < schedule.length; di++) {
        var day = schedule[di];
        html += '<div class="sp-day-block">';
        html += '<div class="sp-day-header" data-day-idx="' + di + '">'
            + '<span>▣ ' + escapeHtml(day.day || '第' + (di + 1) + '天') + '</span></div>';
        html += '<div class="sp-day-content" data-day-idx="' + di + '">';
        if (day.events) {
            for (var ei = 0; ei < day.events.length; ei++) {
                var evt = day.events[ei];
                var enabled = evt.enabled !== false;
                var checkedAttr = enabled ? 'checked' : '';
                html += '<div class="sp-event-card' + (enabled ? '' : ' sp-event-disabled') + '" data-schedule-idx="' + idx + '" data-day="' + di + '" data-evt="' + ei + '">';
                // 顶部行：勾选 + 时间 + 编辑按钮
                html += '<div class="sp-event-top">';
                html += '<input type="checkbox" class="sp-evt-enable" data-schedule-idx="' + idx + '" data-day="' + di + '" data-evt="' + ei + '" ' + checkedAttr + ' title="勾选=注入AI">';
                html += '<span class="event-time">' + escapeHtml(evt.time || '') + '</span>';
                html += '<span class="sp-edit-btn" data-schedule-idx="' + idx + '" data-day="' + di + '" data-evt="' + ei + '" title="编辑">✏️</span>';
                html += '</div>';
                // 内容（显示模式）
                html += '<div class="sp-event-display">';
                if (evt.title) html += '<div class="event-title">' + escapeHtml(evt.title) + '</div>';
                if (evt.location) html += '<div class="event-location">' + escapeHtml(evt.location) + '</div>';
                if (evt.summary) html += '<div class="event-desc">' + escapeHtml(evt.summary) + '</div>';
                html += '</div>';
                // 编辑模式（隐藏）
                html += '<div class="sp-event-edit" style="display:none;">';
                html += '<div class="sp-field"><label>时间</label><input type="text" class="sp-edit-time" value="' + escapeHtml(evt.time || '') + '"></div>';
                html += '<div class="sp-field"><label>事件</label><input type="text" class="sp-edit-title" value="' + escapeHtml(evt.title || '') + '"></div>';
                html += '<div class="sp-field"><label>地点</label><input type="text" class="sp-edit-location" value="' + escapeHtml(evt.location || '') + '"></div>';
                html += '<div class="sp-field"><label>概述</label><textarea class="sp-edit-summary" rows="3">' + escapeHtml(evt.summary || '') + '</textarea></div>';
                html += '<div class="sp-edit-actions">';
                html += '<button class="sp-edit-confirm" data-schedule-idx="' + idx + '" data-day="' + di + '" data-evt="' + ei + '">✓ 确认</button>';
                html += '<button class="sp-edit-cancel">✕ 取消</button>';
                html += '</div></div>';
                html += '</div>';
            }
        }
        if (day.xiaoday_comment) {
            html += '<div class="sp-xiaoday">' + escapeHtml(day.xiaoday_comment) + '</div>';
        }
        html += '</div></div>';
    }
    container.html(html);
}

// ==================== UI Building ====================

function buildPanelHTML() {
    return '<div id="schedule_planner_panel" class="extension_settings">'
        + '<div class="inline-drawer">'
        + '<div class="inline-drawer-toggle inline-drawer-header">'
        + '<b>📅 日程规划 Schedule Planner</b>'
        + '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>'
        + '</div>'
        + '<div class="inline-drawer-content" style="display:none;">'

        // Status
        + '<div class="sp-status inactive" id="sp_status">未注入日程</div>'

        // Active schedules list (top, prominent)
        + '<div class="sp-active-section" id="sp_active_section">'
        + '<h4>📌 现有日程（💉=已注入AI / 💤=未注入）</h4>'
        + '<div id="sp_active_list"></div>'
        + '</div>'

        // Branch tabs
        + '<div class="sp-branch-tabs">'
        + '<button class="sp-branch-tab active" data-branch="personal">👤 个人日程</button>'
        + '<button class="sp-branch-tab" data-branch="world">🌍 世界事件</button>'
        + '</div>'

        // Personal branch
        + '<div class="sp-branch-content" id="sp_branch_personal">'
        + buildBranchHTML('personal')
        + '</div>'

        // World branch
        + '<div class="sp-branch-content" id="sp_branch_world" style="display:none;">'
        + buildBranchHTML('world')
        + '</div>'

        // Shared API settings
        + '<details><summary>⚙ API 设置（共享）</summary>'
        + '<div class="sp-api-settings">'
        + '<div class="api-field"><label>API 模式</label>'
        + '<select id="sp_api_mode">'
        + '<option value="st">使用酒馆主模型 (零配置)</option>'
        + '<option value="custom">独立API (OpenAI兼容)</option>'
        + '</select></div>'
        + '<div id="sp_custom_api_fields" style="display:none;">'
        + '<div class="api-field"><label>API 地址</label>'
        + '<input type="text" id="sp_api_url" placeholder=""></div>'
        + '<div class="api-field"><label>API Key</label>'
        + '<input type="password" id="sp_api_key" placeholder=""></div>'
        + '<div class="api-field"><label>模型名</label>'
        + '<div style="display:flex;gap:4px;">'
        + '<input type="text" id="sp_model" placeholder="" style="flex:1;">'
        + '<button id="sp_fetch_models_btn" style="white-space:nowrap;padding:4px 8px;font-size:0.82em;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:4px;background:transparent;color:var(--SmartThemeBodyColor,#ccc);cursor:pointer;">获取模型</button>'
        + '</div></div>'
        + '<div id="sp_model_select_area"></div>'
        + '</div></div></details>'

        // Generate button
        + '<div class="sp-actions">'
        + '<button id="sp_generate_btn" class="primary">📅 生成</button>'
        + '</div>'

        // Preview area
        + '<div class="sp-schedule-display" id="sp_schedule_area"></div>'

        + '</div></div></div>';
}

function buildBranchHTML(branch) {
    var prefix = 'sp_' + branch;
    var html = '';

    if (branch === 'personal') {
        html += '<div class="sp-field">'
            + '<label>🏷 规划目标角色</label>'
            + '<input type="text" id="' + prefix + '_target_char" placeholder="">'
            + '</div>';
    } else {
        html += '<div class="sp-field">'
            + '<label>🏷 世界事件名称</label>'
            + '<input type="text" id="' + prefix + '_target_world" placeholder="留空则使用当前角色名的世界事件">'
            + '</div>';
    }

    html += '<details><summary>🌍 全局指导</summary>'
        + '<div class="sp-field">'
        + '<textarea id="' + prefix + '_guide" rows="3" placeholder=""></textarea>'
        + '</div></details>';

    html += '<details><summary>⚙ 生成参数</summary>'
        + '<div class="sp-field"><label>规划天数 (1-7)</label>'
        + '<input type="number" id="' + prefix + '_num_days" min="1" max="7" value="7"></div>'
        + '<div class="sp-field"><label>上下文消息数 (0-100)</label>'
        + '<input type="number" id="' + prefix + '_num_context" min="0" max="100" value="20"></div>'
        + '</details>';

    html += '<details><summary>📋 注入源设置</summary>'
        + '<div class="sp-checkbox"><input type="checkbox" id="' + prefix + '_inject_charcard"><label>注入角色卡描述</label></div>';
    if (branch === 'personal') {
        html += '<div class="sp-checkbox"><input type="checkbox" id="' + prefix + '_inject_persona"><label>注入用户人设</label></div>';
    }
    html += '<div class="sp-checkbox"><input type="checkbox" id="' + prefix + '_inject_worldbook"><label>注入世界书</label></div>'
        + '<div class="sp-checkbox"><input type="checkbox" id="' + prefix + '_inject_other"><label>注入其他人物日程表</label></div>'
        + '<div id="' + prefix + '_wb_section" style="display:none;">'
        + '<div class="sp-wb-actions">'
        + '<button class="sp-wb-load-btn" data-branch="' + branch + '">加载世界书</button>'
        + '<button class="sp-wb-selectall-btn" data-branch="' + branch + '">全选</button>'
        + '<button class="sp-wb-deselectall-btn" data-branch="' + branch + '">取消全选</button>'
        + '<button class="sp-wb-save-btn" data-branch="' + branch + '">保存选择</button>'
        + '</div>'
        + '<div class="sp-wb-selector" id="' + prefix + '_wb_container"><span style="font-size:0.8em;color:#888;">点击"加载世界书"获取条目</span></div>'
        + '</div>'
        + '</details>';

    html += '<details><summary>📝 提示词编辑</summary>'
        + '<div class="sp-prompt-section">'
        + '<div class="sp-field"><label>系统提示词</label>'
        + '<textarea id="' + prefix + '_sys_prompt" rows="6"></textarea></div>'
        + '<div class="sp-field"><label>用户提示词</label>'
        + '<textarea id="' + prefix + '_user_prompt" rows="6"></textarea></div>'
        + '<button class="sp-reset-prompts-btn">🔄 恢复默认提示词</button>'
        + '</div></details>';

    return html;
}

// ==================== Rendering ====================

function renderPanel() {
    var settings = getSettings();

    jQuery('.sp-branch-tab').removeClass('active');
    jQuery('.sp-branch-tab[data-branch="' + currentBranch + '"]').addClass('active');
    jQuery('.sp-branch-content').hide();
    jQuery('#sp_branch_' + currentBranch).show();

    renderBranchFields('personal');
    renderBranchFields('world');

    jQuery('#sp_api_mode').val(settings.apiMode || 'st');
    jQuery('#sp_custom_api_fields').toggle(settings.apiMode === 'custom');
    jQuery('#sp_api_url').val(settings.customApiUrl || '');
    jQuery('#sp_api_key').val(settings.customApiKey || '');
    jQuery('#sp_model').val(settings.customModel || '');

    renderStatus();
    renderActiveList();
}

function renderBranchFields(branch) {
    var bs = getBranchSettings(branch);
    var prefix = 'sp_' + branch;

    if (branch === 'personal') {
        jQuery('#' + prefix + '_target_char').val(bs.targetCharName || '');
    } else {
        jQuery('#' + prefix + '_target_world').val(bs.targetWorldName || '');
    }
    jQuery('#' + prefix + '_guide').val(bs.globalGuide || '');
    jQuery('#' + prefix + '_num_days').val(bs.numDays || 7);
    jQuery('#' + prefix + '_num_context').val(bs.numContextMessages || 20);
    jQuery('#' + prefix + '_inject_charcard').prop('checked', bs.injectCharCard);
    if (branch === 'personal') {
        jQuery('#' + prefix + '_inject_persona').prop('checked', bs.injectUserPersona);
    }
    jQuery('#' + prefix + '_inject_worldbook').prop('checked', bs.injectWorldBook);
    jQuery('#' + prefix + '_inject_other').prop('checked', bs.injectOtherSchedules);
    jQuery('#' + prefix + '_wb_section').toggle(!!bs.injectWorldBook);
    jQuery('#' + prefix + '_sys_prompt').val(bs.systemPrompt || getDefaultSysPrompt(branch));
    jQuery('#' + prefix + '_user_prompt').val(bs.userPrompt || getDefaultUserPrompt(branch));
}

function renderStatus() {
    var settings = getSettings();
    var el = jQuery('#sp_status');
    var injecting = settings.activeSchedules.filter(function(x) { return x.injecting; });
    if (injecting.length > 0) {
        var names = injecting.map(function(x) { return x.name; }).join('、');
        el.removeClass('inactive').addClass('active')
            .text('✓ 正在注入 ' + injecting.length + ' 条日程：' + names);
    } else {
        el.removeClass('active').addClass('inactive').text('未注入日程');
    }
}

function renderActiveList() {
    var settings = getSettings();
    var el = jQuery('#sp_active_list');
    if (!settings.activeSchedules.length) {
        el.html('<p style="font-size:0.8em;color:#888;">暂无日程，请生成</p>');
        return;
    }
    var html = settings.activeSchedules.map(function(item, idx) {
        var typeLabel = item.branch === 'world' ? '🌍' : '👤';
        var injectLabel = item.injecting ? '💉' : '💤';
        var injectTitle = item.injecting ? '已注入AI，点击取消' : '未注入，点击注入AI';
        var dayCount = item.schedule ? item.schedule.length : 0;
        return '<div class="sp-active-item">'
            + '<span class="sp-active-inject" data-idx="' + idx + '" title="' + injectTitle + '">' + injectLabel + '</span>'
            + '<span class="sp-active-name" data-idx="' + idx + '" title="点击预览">'
            + typeLabel + ' <b>' + escapeHtml(item.name) + '</b> (' + dayCount + '天)'
            + '</span>'
            + '<span class="sp-active-delete" data-idx="' + idx + '" title="移除">✕</span>'
            + '</div>';
    }).join('');
    el.html(html);
}

// ==================== Event Binding ====================

function bindEvents() {
    // Branch tabs
    jQuery(document).on('click', '.sp-branch-tab', function() {
        currentBranch = jQuery(this).data('branch');
        renderPanel();
    });

    // Personal branch fields
    jQuery('#sp_personal_target_char').on('input', function() {
        getBranchSettings('personal').targetCharName = jQuery(this).val();
        saveSettings();
    });
    jQuery('#sp_personal_guide').on('input', function() {
        getBranchSettings('personal').globalGuide = jQuery(this).val();
        saveSettings();
    });
    jQuery('#sp_personal_num_days').on('change', function() {
        var v = Math.max(1, Math.min(7, parseInt(jQuery(this).val()) || 7));
        jQuery(this).val(v);
        getBranchSettings('personal').numDays = v;
        saveSettings();
    });
    jQuery('#sp_personal_num_context').on('change', function() {
        var v = Math.max(0, Math.min(100, parseInt(jQuery(this).val()) || 20));
        jQuery(this).val(v);
        getBranchSettings('personal').numContextMessages = v;
        saveSettings();
    });
    jQuery('#sp_personal_inject_charcard').on('change', function() {
        getBranchSettings('personal').injectCharCard = jQuery(this).is(':checked');
        saveSettings();
    });
    jQuery('#sp_personal_inject_persona').on('change', function() {
        getBranchSettings('personal').injectUserPersona = jQuery(this).is(':checked');
        saveSettings();
    });
    jQuery('#sp_personal_inject_worldbook').on('change', function() {
        var checked = jQuery(this).is(':checked');
        getBranchSettings('personal').injectWorldBook = checked;
        jQuery('#sp_personal_wb_section').toggle(checked);
        saveSettings();
    });
    jQuery('#sp_personal_inject_other').on('change', function() {
        getBranchSettings('personal').injectOtherSchedules = jQuery(this).is(':checked');
        saveSettings();
    });
    jQuery('#sp_personal_sys_prompt').on('input', function() {
        var val = jQuery(this).val();
        getBranchSettings('personal').systemPrompt = val === getDefaultSysPrompt('personal') ? '' : val;
        saveSettings();
    });
    jQuery('#sp_personal_user_prompt').on('input', function() {
        var val = jQuery(this).val();
        getBranchSettings('personal').userPrompt = val === getDefaultUserPrompt('personal') ? '' : val;
        saveSettings();
    });

    // World branch fields
    jQuery('#sp_world_target_world').on('input', function() {
        getBranchSettings('world').targetWorldName = jQuery(this).val();
        saveSettings();
    });
    jQuery('#sp_world_guide').on('input', function() {
        getBranchSettings('world').globalGuide = jQuery(this).val();
        saveSettings();
    });
    jQuery('#sp_world_num_days').on('change', function() {
        var v = Math.max(1, Math.min(7, parseInt(jQuery(this).val()) || 7));
        jQuery(this).val(v);
        getBranchSettings('world').numDays = v;
        saveSettings();
    });
    jQuery('#sp_world_num_context').on('change', function() {
        var v = Math.max(0, Math.min(100, parseInt(jQuery(this).val()) || 20));
        jQuery(this).val(v);
        getBranchSettings('world').numContextMessages = v;
        saveSettings();
    });
    jQuery('#sp_world_inject_charcard').on('change', function() {
        getBranchSettings('world').injectCharCard = jQuery(this).is(':checked');
        saveSettings();
    });
    jQuery('#sp_world_inject_worldbook').on('change', function() {
        var checked = jQuery(this).is(':checked');
        getBranchSettings('world').injectWorldBook = checked;
        jQuery('#sp_world_wb_section').toggle(checked);
        saveSettings();
    });
    jQuery('#sp_world_inject_other').on('change', function() {
        getBranchSettings('world').injectOtherSchedules = jQuery(this).is(':checked');
        saveSettings();
    });
    jQuery('#sp_world_sys_prompt').on('input', function() {
        var val = jQuery(this).val();
        getBranchSettings('world').systemPrompt = val === getDefaultSysPrompt('world') ? '' : val;
        saveSettings();
    });
    jQuery('#sp_world_user_prompt').on('input', function() {
        var val = jQuery(this).val();
        getBranchSettings('world').userPrompt = val === getDefaultUserPrompt('world') ? '' : val;
        saveSettings();
    });

    // Worldbook buttons
    jQuery(document).on('click', '.sp-wb-load-btn', function() {
        onLoadWorldbooks(jQuery(this).data('branch'));
    });
    jQuery(document).on('click', '.sp-wb-selectall-btn', function() {
        var branch = jQuery(this).data('branch');
        jQuery('#sp_' + branch + '_wb_container .sp-wb-entry-cb').prop('checked', true);
    });
    jQuery(document).on('click', '.sp-wb-deselectall-btn', function() {
        var branch = jQuery(this).data('branch');
        jQuery('#sp_' + branch + '_wb_container .sp-wb-entry-cb').prop('checked', false);
    });
    jQuery(document).on('click', '.sp-wb-save-btn', function() {
        saveWbSelections(jQuery(this).data('branch'));
    });

    // Reset prompts
    jQuery(document).on('click', '.sp-reset-prompts-btn', function() {
        var branch = currentBranch;
        var prefix = 'sp_' + branch;
        jQuery('#' + prefix + '_sys_prompt').val(getDefaultSysPrompt(branch));
        jQuery('#' + prefix + '_user_prompt').val(getDefaultUserPrompt(branch));
        getBranchSettings(branch).systemPrompt = '';
        getBranchSettings(branch).userPrompt = '';
        saveSettings();
        toastr.info('提示词已恢复默认');
    });

    // Shared API
    jQuery('#sp_api_mode').on('change', function() {
        getSettings().apiMode = jQuery(this).val();
        jQuery('#sp_custom_api_fields').toggle(getSettings().apiMode === 'custom');
        saveSettings();
    });
    jQuery('#sp_api_url').on('input', function() { getSettings().customApiUrl = jQuery(this).val(); saveSettings(); });
    jQuery('#sp_api_key').on('input', function() { getSettings().customApiKey = jQuery(this).val(); saveSettings(); });
    jQuery('#sp_model').on('input', function() { getSettings().customModel = jQuery(this).val(); saveSettings(); });
    jQuery('#sp_fetch_models_btn').on('click', function() { fetchModels(); });

    // Generate
    jQuery('#sp_generate_btn').on('click', async function() { await generateSchedule(); });

    // Active list
    jQuery(document).on('click', '.sp-active-inject', function() {
        toggleItemInjection(parseInt(jQuery(this).data('idx')));
    });
    jQuery(document).on('click', '.sp-active-name', function() {
        togglePreview(parseInt(jQuery(this).data('idx')));
    });
    jQuery(document).on('click', '.sp-active-delete', function(e) {
        e.stopPropagation();
        removeScheduleItem(parseInt(jQuery(this).data('idx')));
    });

    // Day block collapse
    jQuery(document).on('click', '.sp-day-header', function() {
        var idx = jQuery(this).data('day-idx');
        jQuery('.sp-day-content[data-day-idx="' + idx + '"]').toggleClass('collapsed');
    });

    // 事件启用/禁用勾选
    jQuery(document).on('change', '.sp-evt-enable', function() {
        var si = parseInt(jQuery(this).data('schedule-idx'));
        var di = parseInt(jQuery(this).data('day'));
        var ei = parseInt(jQuery(this).data('evt'));
        var settings = getSettings();
        var item = settings.activeSchedules[si];
        if (item && item.schedule[di] && item.schedule[di].events[ei]) {
            item.schedule[di].events[ei].enabled = jQuery(this).is(':checked');
            saveSettings();
            updateInjection();
            // 更新卡片样式
            jQuery(this).closest('.sp-event-card').toggleClass('sp-event-disabled', !jQuery(this).is(':checked'));
        }
    });

    // 编辑按钮
    jQuery(document).on('click', '.sp-edit-btn', function(e) {
        e.stopPropagation();
        var card = jQuery(this).closest('.sp-event-card');
        card.find('.sp-event-display').hide();
        card.find('.sp-event-edit').show();
        card.find('.sp-edit-btn').hide();
    });

    // 确认编辑
    jQuery(document).on('click', '.sp-edit-confirm', function() {
        var si = parseInt(jQuery(this).data('schedule-idx'));
        var di = parseInt(jQuery(this).data('day'));
        var ei = parseInt(jQuery(this).data('evt'));
        var card = jQuery(this).closest('.sp-event-card');
        var settings = getSettings();
        var item = settings.activeSchedules[si];
        if (item && item.schedule[di] && item.schedule[di].events[ei]) {
            var evt = item.schedule[di].events[ei];
            evt.time = card.find('.sp-edit-time').val();
            evt.title = card.find('.sp-edit-title').val();
            evt.location = card.find('.sp-edit-location').val();
            evt.summary = card.find('.sp-edit-summary').val();
            saveSettings();
            updateInjection();
            // 重新渲染预览
            renderSchedulePreview(si);
            toastr.success('事件已更新');
        }
    });

    // 取消编辑
    jQuery(document).on('click', '.sp-edit-cancel', function() {
        var card = jQuery(this).closest('.sp-event-card');
        card.find('.sp-event-edit').hide();
        card.find('.sp-event-display').show();
        card.find('.sp-edit-btn').show();
    });
}

// ==================== Init ====================

try {
    console.log(DEBUG_PREFIX, 'Initializing...');
    jQuery('#extensions_settings2').append(buildPanelHTML());
    bindEvents();
    updateInjection();
    renderPanel();

    var ctx = getContext();
    if (ctx.eventSource && ctx.event_types) {
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, function() {
            console.log(DEBUG_PREFIX, 'Chat changed.');
            updateInjection();
            renderPanel();
        });
    }
    console.log(DEBUG_PREFIX, 'Extension loaded successfully.');
} catch (err) {
    console.error(DEBUG_PREFIX, 'Init failed:', err);
}
