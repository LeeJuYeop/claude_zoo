const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0d1117',
    titleBarStyle: 'default',
    title: 'Claude Code 생태계 대시보드'
  })

  win.loadFile(path.join(__dirname, 'src', 'index.html'))
}

// JSON 파일을 안전하게 읽기 (실패해도 크래시 없음)
function readJsonSafe(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return { data: JSON.parse(content), error: null }
  } catch (e) {
    return { data: null, error: e.message }
  }
}

// commands 디렉토리를 재귀 탐색해서 스킬 목록 반환
function getSkills(commandsPath) {
  const skills = []
  try {
    if (!fs.existsSync(commandsPath)) return skills

    const scanDir = (dir, prefix) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scanDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name)
        } else if (entry.name.endsWith('.md')) {
          const baseName = entry.name.replace('.md', '')
          const skillName = prefix ? `${prefix}/${baseName}` : baseName
          // 파일 첫 줄에서 description 추출 시도
          let description = ''
          try {
            const lines = fs.readFileSync(fullPath, 'utf-8').split('\n')
            const titleLine = lines.find(l => l.startsWith('# '))
            if (titleLine) description = titleLine.replace('# ', '').trim()
          } catch (_) {}
          skills.push({ name: skillName, description })
        }
      }
    }

    scanDir(commandsPath, '')
  } catch (_) {}
  return skills
}

// 에이전트 파일 파싱 (YAML frontmatter)
function parseAgentFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const filename = path.basename(filePath, '.md')
    if (!fmMatch) return { name: filename, description: '', tools: [], model: null }

    const fm = fmMatch[1]
    const name = (fm.match(/^name:\s*['"]?(.+?)['"]?\s*$/m) || [])[1]?.trim() || filename
    const description = (fm.match(/^description:\s*['"]?(.+?)['"]?\s*$/m) || [])[1]?.trim() || ''
    const model = (fm.match(/^model:\s*['"]?(.+?)['"]?\s*$/m) || [])[1]?.trim() || null

    let tools = []
    const inlineTools = fm.match(/^tools:\s*(.+)$/m)
    if (inlineTools && !inlineTools[1].trim().startsWith('-')) {
      tools = inlineTools[1].split(',').map(t => t.trim()).filter(Boolean)
    } else {
      const listBlock = fm.match(/^tools:\s*\n((?:[ \t]*-[ \t]*.+\n?)*)/m)
      if (listBlock) {
        tools = (listBlock[1].match(/[ \t]*-[ \t]*(.+)/g) || [])
          .map(t => t.replace(/^[ \t]*-[ \t]*/, '').trim())
      }
    }

    return { name, description, tools, model }
  } catch (_) {
    return { name: path.basename(filePath, '.md'), description: '', tools: [], model: null }
  }
}

// 에이전트 디렉토리 스캔
function scanAgents(agentsDir, scope, projectPath) {
  const agents = []
  try {
    if (!fs.existsSync(agentsDir)) return agents
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const filePath = path.join(agentsDir, entry.name)
      const meta = parseAgentFile(filePath)
      agents.push({ ...meta, scope, projectPath: projectPath || null, filePath })
    }
  } catch (_) {}
  return agents
}

// MCP 서버 정보 읽기
function getMcpServers(installPath) {
  const mcpResult = readJsonSafe(path.join(installPath, '.mcp.json'))
  if (!mcpResult.data || !mcpResult.data.mcpServers) return {}
  return mcpResult.data.mcpServers
}

ipcMain.handle('get-ecosystem-data', async () => {
  const homeDir = os.homedir()
  const claudeDir = path.join(homeDir, '.claude')
  const errors = []

  // 1. installed_plugins.json 읽기
  const installedResult = readJsonSafe(
    path.join(claudeDir, 'plugins', 'installed_plugins.json')
  )
  if (installedResult.error) {
    errors.push({ file: 'installed_plugins.json', message: installedResult.error })
  }

  // 2. settings.json 읽기
  const settingsResult = readJsonSafe(path.join(claudeDir, 'settings.json'))
  if (settingsResult.error) {
    errors.push({ file: 'settings.json', message: settingsResult.error })
  }

  // 3. blocklist.json 읽기
  const blocklistResult = readJsonSafe(
    path.join(claudeDir, 'plugins', 'blocklist.json')
  )

  const globalEnabledPlugins = settingsResult.data?.enabledPlugins || {}
  const blockedList = (blocklistResult.data?.plugins || [])
  const blockedIds = new Set(blockedList.map(p => p.plugin))
  const installedMap = installedResult.data?.plugins || {}

  // 스코프별 설정 파일에서 enabledPlugins 읽기 (캐시)
  const projectSettingsCache = new Map()
  function getScopeEnabledPlugins(scope, projectPath) {
    if (scope === 'user') return globalEnabledPlugins
    if (!projectPath) return null
    const settingsFile = scope === 'local' ? 'settings.local.json' : 'settings.json'
    const cacheKey = `${projectPath}::${settingsFile}`
    if (!projectSettingsCache.has(cacheKey)) {
      const result = readJsonSafe(path.join(projectPath, '.claude', settingsFile))
      projectSettingsCache.set(cacheKey, result.data?.enabledPlugins ?? null)
    }
    return projectSettingsCache.get(cacheKey)
  }

  const plugins = []

  for (const [pluginId, instances] of Object.entries(installedMap)) {
    for (const instance of instances) {
      const { scope, projectPath } = instance
      const installPath = instance.installPath

      // 스코프 설정 파일에 없으면 실제로는 삭제된 항목 → 건너뜀
      const scopeEnabledPlugins = getScopeEnabledPlugins(scope, projectPath)
      if (scopeEnabledPlugins !== null && !(pluginId in scopeEnabledPlugins)) continue

      const skills = getSkills(path.join(installPath, 'commands'))
      const mcpServers = getMcpServers(installPath)
      const [name, marketplace] = pluginId.split('@')
      const blockedEntry = blockedList.find(p => p.plugin === pluginId)
      const isEnabled = scopeEnabledPlugins ? scopeEnabledPlugins[pluginId] !== false : true

      plugins.push({
        id: pluginId,
        instanceKey: `${pluginId}::${scope}::${projectPath || installPath}`,
        name: name || pluginId,
        marketplace: marketplace || 'unknown',
        version: instance.version || 'unknown',
        scope,
        projectPath: projectPath || null,
        installPath,
        isEnabled,
        isBlocked: blockedIds.has(pluginId),
        blockedReason: blockedEntry?.reason || null,
        installedAt: instance.installedAt || null,
        skills,
        mcpServers,
        skillCount: skills.length,
        mcpCount: Object.keys(mcpServers).length
      })
    }
  }

  // Sub-agents 수집
  const agents = []
  agents.push(...scanAgents(path.join(claudeDir, 'agents'), 'user', null))

  const knownProjectPaths = new Set()
  for (const instances of Object.values(installedMap)) {
    for (const inst of instances) {
      if (inst.projectPath) knownProjectPaths.add(inst.projectPath)
    }
  }
  for (const pp of knownProjectPaths) {
    agents.push(...scanAgents(path.join(pp, '.claude', 'agents'), 'project', pp))
  }

  return { plugins, agents, errors, claudeDir }
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
