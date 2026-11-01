export const settingsDefaults = {
  quotaReservePercent: 10,
  tokenAnalysisEnabled: true,
  tokenAnalysisIntervalHours: 24,
};

export function validateSettings(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Settings must be an object');
  for(const [key,v] of Object.entries(value)) {
    if(!Object.hasOwn(settingsDefaults,key))throw Error(`Unknown setting: ${key}`);
    if(key==='tokenAnalysisEnabled') {if(typeof v!=='boolean')throw Error(`Invalid setting: ${key}`);}
    else if(!Number.isSafeInteger(v)||v<(key==='quotaReservePercent'?0:1)||v>(key==='quotaReservePercent'?99:168))throw Error(`Invalid setting: ${key}`);
  }
  return value;
}

export function factorySettings(store,config) {
  return {...settingsDefaults,...Object.fromEntries(Object.keys(settingsDefaults).filter(k=>config[k]!==undefined).map(k=>[k,config[k]])),...store.get('factory:settings',{})};
}

export function updateSettings(store,config,value) {
  validateSettings(value);
  return store.tx(()=>{
    const settings=validateSettings({...factorySettings(store,config),...value});
    store.set('factory:settings',settings);
    store.event('factory.settings.updated',null,{settings});
    return settings;
  });
}

// A reset timestamp alone is not evidence of recovery. Only a fresh, complete
// official sample can replace a snapshot that already reached the reserve.
export function quotaReserve(quota,settings) {
  const windows=[quota?.primary,quota?.secondary].filter(w=>Number.isFinite(w?.usedPercent));
  const remainingPercent=windows.length?Math.max(0,Math.min(...windows.map(w=>100-w.usedPercent))):null;
  return {threshold:settings.quotaReservePercent,remainingPercent,
    blocked:settings.quotaReservePercent>0&&remainingPercent!==null&&remainingPercent<=settings.quotaReservePercent};
}

export function restrictiveQuota(last,next,now) {
  const window=(a,b)=>!Number.isFinite(b?.usedPercent)?a||b:!Number.isFinite(a?.usedPercent)||b.usedPercent>=a.usedPercent?b:a;
  return {...last,...next,known:false,complete:false,checkedAt:now,
    observedAt:last?.observedAt??next.observedAt??now,
    primary:window(last?.primary,next.primary),secondary:window(last?.secondary,next.secondary),
    blocked:!!(next.blocked||(last?.blocked&&last.until>now)),
    until:Math.max(last?.blocked?last.until||0:0,next.until||0)};
}
