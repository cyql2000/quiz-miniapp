// 共用测试桩：内存文件系统（模拟 wx.getFileSystemManager）
// 用途：本地化改造后，题库明细落在沙箱文件里，页面测试需要能"提前放一份题库进去"。
const ROOT = '/usr';

function parentOf(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }

function createFs() {
  const files = new Map(); // 绝对路径 -> Buffer
  const dirs = new Set([ROOT]);

  const fsm = {
    accessSync(p) {
      if (!files.has(p) && !dirs.has(p)) throw new Error('accessSync:fail no such file, ' + p);
    },
    mkdirSync(p, recursive) {
      if (dirs.has(p)) { const e = new Error('mkdirSync:fail file already exists'); e.errMsg = 'mkdirSync:fail'; throw e; }
      if (recursive) {
        let cur = '';
        p.split('/').filter(Boolean).forEach((seg) => { cur += '/' + seg; dirs.add(cur); });
      } else {
        dirs.add(p);
      }
    },
    readFileSync(p, encoding) {
      if (!files.has(p)) throw new Error('readFileSync:fail no such file, ' + p);
      const buf = files.get(p);
      return encoding ? buf.toString(encoding) : buf;
    },
    writeFileSync(p, data) {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
    },
    copyFileSync(src, dst) {
      if (!files.has(src)) throw new Error('copyFileSync:fail no such file, ' + src);
      files.set(dst, Buffer.from(files.get(src)));
    },
    unlinkSync(p) {
      if (!files.has(p)) throw new Error('unlinkSync:fail no such file, ' + p);
      files.delete(p);
    },
    rmdirSync(p, recursive) {
      if (recursive) {
        [...files.keys()].forEach((k) => { if (k.indexOf(p + '/') === 0) files.delete(k); });
        [...dirs].forEach((d) => { if (d.indexOf(p + '/') === 0) dirs.delete(d); });
      }
      dirs.delete(p);
    },
    statSync(p) {
      if (files.has(p)) return { size: files.get(p).byteLength, isDirectory: () => false };
      if (dirs.has(p)) return { size: 0, isDirectory: () => true };
      throw new Error('statSync:fail no such file, ' + p);
    },
    readdirSync(p) {
      if (!dirs.has(p)) throw new Error('readdirSync:fail no such directory, ' + p);
      const out = [];
      files.forEach((_, k) => { if (parentOf(k) === p) out.push(k.slice(p.length + 1)); });
      return out;
    }
  };

  return { fsm, files, dirs };
}

// 给已有的 wx 桩补上文件系统能力（保留其原有的 storage / 交互桩）
function attach(wxObj) {
  const ctx = createFs();
  wxObj.env = { USER_DATA_PATH: ROOT };
  wxObj.getFileSystemManager = () => ctx.fsm;
  return ctx;
}

module.exports = { ROOT, createFs, attach };
