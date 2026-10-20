// 字体后台检测不能弹浏览器权限；只有用户明确打开字体下拉才允许请求本机清单。
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {browserSystemFonts} from '../../src/web/fonts';

describe('浏览器本机字体权限边界',()=>{
  const query=vi.fn().mockResolvedValue([{family:'JetBrains Mono'},{family:'JetBrains Mono'}]);
  beforeEach(()=>{
    query.mockClear();
    Object.defineProperty(window,'isSecureContext',{configurable:true,value:true});
    Object.defineProperty(window,'queryLocalFonts',{configurable:true,value:query});
    Object.defineProperty(navigator,'userActivation',{configurable:true,value:{isActive:true}});
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
  });
  afterEach(()=>{vi.restoreAllMocks();});
  it('后台检测只给出无权限回退，明确操作才查询并去重',async()=>{
    expect((await browserSystemFonts()).map((font)=>font.family)).toEqual(['sans-serif','serif','monospace']);
    expect(query).not.toHaveBeenCalled();
    const fonts=await browserSystemFonts(true);
    expect(query).toHaveBeenCalledTimes(1);expect(fonts.filter((font)=>font.family==='JetBrains Mono')).toHaveLength(1);
  });
  it('缺少用户激活或权限被拒绝时，仍可使用通用字体',async()=>{
    Object.defineProperty(navigator,'userActivation',{configurable:true,value:{isActive:false}});
    expect(await browserSystemFonts(true)).toHaveLength(3);expect(query).not.toHaveBeenCalled();
  });
});
