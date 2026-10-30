// 在隔离的 HKCU 临时键中运行真实 NSIS 宏，验证安装、旧版本修复和卸载均不破坏其他应用。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'));
const associations: { name: string; ext: string[]; rank: string; role?: string }[] = config.bundle.fileAssociations;

it('macOS 公共格式只声明备用处理程序，文档预览声明只读角色', () => {
  expect(associations.every(({ rank }) => rank === 'Alternate')).toBe(true);
  expect(associations.find(({ name }) => name === 'NoteBoard.DocumentPreview')?.role).toBe('Viewer');
});

it.skipIf(process.platform !== 'win32')('Windows 真实注册表回归：新增候选、备份恢复、重复升级、卸载和第三方菜单保护', () => {
  const makensis = process.env.NSIS_MAKENSIS
    ?? join(process.env.LOCALAPPDATA ?? '', 'tauri/NSIS/makensis.exe');
  // Windows 开发环境必须提供编译器；不以静默跳过掩盖安装器缺少验证。
  expect(existsSync(makensis), '请安装 Tauri NSIS 工具链或设置 NSIS_MAKENSIS').toBe(true);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'noteboard-associations-'));
  const registryRoot = `Software\\CrazyFigure\\NoteBoard\\AssociationTests\\${randomUUID()}`;
  const scriptPath = join(fixtureRoot, 'test.nsi');
  const exePath = join(fixtureRoot, 'test.exe');
  const entries = associations.flatMap(({ name, ext }) => ext.map((extension) => ({ name, extension })));
  const install = (extension: string, name: string) =>
    `!insertmacro APP_ASSOCIATE "${extension}" "${name}" "NoteBoard" "icon" "Open" "unused"`;
  // 每个断言写入独立退出码；失败后也会清理测试键，不操作真实 Classes 和 UserChoice。
  let assertion = 0;
  const equal = (path: string, value: string, expected: string) => {
    const id = ++assertion;
    return `ClearErrors
      ReadRegStr $0 HKCU "${registryRoot}\\${path}" "${value}"
      IfErrors fail_${id}
      StrCmp $0 "${expected}" assert_${id}
      fail_${id}:
      StrCpy $9 ${id}
      Goto cleanup
      assert_${id}:`;
  };
  const missing = (path: string, value = '') => {
    const id = ++assertion;
    return `ClearErrors
      ReadRegStr $0 HKCU "${registryRoot}\\${path}" "${value}"
      IfErrors assert_${id}
      StrCpy $9 ${id}
      Goto cleanup
      assert_${id}:`;
  };
  const cases = entries.map(({ name, extension }, index) => {
    const key = `.${extension}`;
    return `
      ; 全新扩展名只增加候选项，不创建默认值；没有修复时不清理 Explorer 缓存。
      WriteRegStr HKCU "${registryRoot}\\ShellNewCache" "Classes" "cached-list"
      WriteRegStr HKCU "${registryRoot}\\ShellNewCache" "~reserved~" "cached-time"
      StrCpy $NB_AssociationsRepaired 0
      ${install(extension, name)}
      ${missing(key)}
      !insertmacro NB_INVALIDATE_ASSOCIATION_CACHE
      ${equal('ShellNewCache', 'Classes', 'cached-list')}

      ; 新装及用户已改用其他程序：只新增有效候选，保留默认值、历史备份和第三方新建菜单。
      WriteRegStr HKCU "${registryRoot}\\${key}" "" "Other.App"
      WriteRegStr HKCU "${registryRoot}\\${key}" "${name}_backup" "Original.App"
      WriteRegStr HKCU "${registryRoot}\\${key}" "Content Type" "original/type"
      WriteRegStr HKCU "${registryRoot}\\${key}\\Other.App\\ShellNew" "FileName" "template"
      WriteRegStr HKCU "${registryRoot}\\${key}\\OpenWithProgids" "Other.App" ""
      ${install(extension, name)}
      ${equal(key, '', 'Other.App')}
      ${equal(key, `${name}_backup`, 'Original.App')}
      ${equal(`${name}\\shell\\open\\command`, '', '$\\"C:\\Program Files\\NoteBoard\\noteboard.exe$\\" $\\"%1$\\"')}
      ${equal(`Applications\\noteboard.exe\\SupportedTypes`, key, '')}

      ; 修复真实的旧覆盖，并再次安装验证幂等。
      WriteRegStr HKCU "${registryRoot}\\${key}" "" "${name}"
      ${install(extension, name)}
      ${equal(key, '', 'Original.App')}
      !insertmacro NB_INVALIDATE_ASSOCIATION_CACHE
      ${missing('ShellNewCache', 'Classes')}
      ${missing('ShellNewCache', '~reserved~')}
      ${install(extension, name)}
      ${equal(key, '', 'Original.App')}

      ; 空备份和重复安装产生的自身备份均移除用户级覆盖，让机器级关联重新生效。
      WriteRegStr HKCU "${registryRoot}\\${key}" "" "${name}"
      WriteRegStr HKCU "${registryRoot}\\${key}" "${name}_backup" "${index % 2 ? name : ''}"
      ${install(extension, name)}
      ${missing(key)}
      ${install(extension, name)}
      ${missing(key)}

      ; 无备份不能认定是旧安装器覆盖；缺失默认值也不得被旧备份重新创建。
      DeleteRegValue HKCU "${registryRoot}\\${key}" "${name}_backup"
      WriteRegStr HKCU "${registryRoot}\\${key}" "" "${name}"
      ${install(extension, name)}
      ${equal(key, '', name)}
      DeleteRegValue HKCU "${registryRoot}\\${key}" ""
      WriteRegStr HKCU "${registryRoot}\\${key}" "${name}_backup" "Original.App"
      ${install(extension, name)}
      ${missing(key)}

      ; 旧卸载器恢复的空字符串不能继续遮盖系统关联。
      WriteRegStr HKCU "${registryRoot}\\${key}" "" ""
      WriteRegStr HKCU "${registryRoot}\\${key}" "${name}_backup" ""
      ${install(extension, name)}
      ${missing(key)}

      ; 类型异常的备份不用于恢复。
      WriteRegStr HKCU "${registryRoot}\\${key}" "" "${name}"
      WriteRegDWORD HKCU "${registryRoot}\\${key}" "${name}_backup" 1
      ${install(extension, name)}
      ${equal(key, '', name)}

      ; 卸载不得重新应用过期备份，也不能删除共享扩展名或第三方子键。
      WriteRegStr HKCU "${registryRoot}\\${key}" "" "Other.App"
      WriteRegStr HKCU "${registryRoot}\\${key}" "${name}_backup" "Original.App"
      !insertmacro APP_UNASSOCIATE "${extension}" "${name}"
      ${equal(key, '', 'Other.App')}
      ${equal(key, 'Content Type', 'original/type')}
      ${equal(`${key}\\Other.App\\ShellNew`, 'FileName', 'template')}
      ${equal(`${key}\\OpenWithProgids`, 'Other.App', '')}
      ${missing(`${key}\\OpenWithProgids`, name)}
    `;
  }).join('\n');
  const script = `Unicode true
    !include LogicLib.nsh
    ; 模拟 Tauri 在引入 hook 前定义的宏；生产文件必须替换这两个不安全入口。
    !macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
      !error "unsafe association macro"
    !macroend
    !macro APP_UNASSOCIATE EXT FILECLASS
      !error "unsafe unassociation macro"
    !macroend
    !define NB_CLASSES_ROOT "${registryRoot}"
    !define NB_SHELLNEW_CACHE "${registryRoot}\\ShellNewCache"
    !define MAINBINARYNAME "noteboard"
    !include "${resolve('src-tauri/resources/nsis/file-associations.nsh')}"
    OutFile "${exePath}"
    RequestExecutionLevel user
    SilentInstall silent
    Section
      SetRegView 64
      StrCpy $INSTDIR "C:\\Program Files\\NoteBoard"
      StrCpy $9 0
      ${cases}
      cleanup:
      DeleteRegKey HKCU "${registryRoot}"
      SetErrorLevel $9
    SectionEnd`;
  try {
    writeFileSync(scriptPath, script, 'utf8');
    execFileSync(makensis, ['/V2', '-INPUTCHARSET', 'UTF8', scriptPath], { stdio: 'pipe' });
    execFileSync(exePath, ['/S'], { stdio: 'pipe', timeout: 30_000 });
  } finally {
    // 双重清理仅限本次 UUID 对应的临时键，以及 mkdtemp 返回的目录。
    spawnSync('reg.exe', ['delete', `HKCU\\${registryRoot}`, '/f'], { stdio: 'ignore' });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 60_000);
