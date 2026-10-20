// 固定上游版本的 Embind 胶水默认用 Function 动态生成调用器，会被应用 CSP 拒绝。
// 使用普通闭包执行同样的线性参数转换与析构流程；只改 JS 绑定层，不改 LibreDWG WASM。
import {createHash} from 'node:crypto';

/** 构建时严格校对上游，升级依赖必须重新审查适配，禁止静默替换失败或放宽主程序 CSP。 */
export function cspCompatibleRuntime(source){
  if(createHash('sha256').update(source).digest('hex')!=='62deaef11c2d6cf8fd0a0ee83d29120ca40bdabc2cdd9baa1f7911410bf9d73f')throw new Error('LibreDWG 绑定层已变化，请审查 CSP 适配');
  const start=source.indexOf('function createJsInvoker('),end=source.indexOf('var heap32VectorToArray=',start);
  if(start<0||end<0)throw new Error('LibreDWG 调用器边界缺失');
  const craft=`function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
    if(argTypes.length<2)throwBindingError('argTypes array size mismatch');
    const method=argTypes[1]!==null&&classType!==null,stack=usesDestructorStack(argTypes);
    return createNamedFunction(humanName,function(...args){
      const destructors=stack?[]:null,wired=[cppTargetFunc],direct=[];
      const convert=(type,value)=>{const wire=type.toWireType(destructors,value);wired.push(wire);if(!stack&&type.destructorFunction!==null)direct.push([type.destructorFunction,wire]);};
      if(method)convert(argTypes[1],this);
      for(let i=2;i<argTypes.length;i++)convert(argTypes[i],args[i-2]);
      const result=cppInvokerFunc(...wired);
      if(stack)runDestructors(destructors);else for(const [destroy,value]of direct)destroy(value);
      return argTypes[0].isVoid?undefined:argTypes[0].fromWireType(result);
    });
  }`;
  source=source.slice(0,start)+craft+source.slice(end);
  const emval=source.indexOf('var __emval_create_invoker='),emvalEnd=source.indexOf('function __emval_incref(',emval);
  if(emval<0||emvalEnd<0)throw new Error('LibreDWG JS 回调绑定边界缺失');
  const callback=`var __emval_create_invoker=function(argCount,argTypesPtr,kind){
    const [retType,...argTypes]=emval_lookupTypes(argCount,argTypesPtr>>>0);
    const invoker=function(handle,methodName,destructorsRef,args){
      const values=argTypes.map((type,i)=>type.readValueFromPointer((args+i*8)>>>0));
      let result;
      if(kind===0)result=Reflect.apply(Emval.toValue(handle),undefined,values);
      else if(kind===1){const owner=Emval.toValue(handle);result=Reflect.apply(owner[getStringOrSymbol(methodName)],owner,values);}
      else if(kind===2)result=Reflect.construct(Emval.toValue(handle),values);
      else if(kind===3)result=values.at(-1);
      else throwBindingError('Unsupported emval call kind');
      if(!retType.isVoid)return emval_returnValue(retType.toWireType.bind(retType),destructorsRef,result);
    };
    return emval_addMethodCaller(createNamedFunction('methodCaller',invoker));
  };`;
  source=source.slice(0,emval)+callback+source.slice(emvalEnd);
  if(/new Function|\beval\(/.test(source))throw new Error('LibreDWG 仍包含动态代码执行');
  return source;
}
