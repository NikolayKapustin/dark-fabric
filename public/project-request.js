// Persist an immutable request before sending it: response loss and page reload
// must retry the same operation, not create another project.
export function projectRequests(storage,installationId) {
  const key='dark-fabric:project-request:'+installationId;
  return {
    read(){const value=storage.getItem(key);return value?JSON.parse(value):null;},
    prepare(payload){
      const pending=this.read();if(pending)return pending;
      storage.setItem(key,JSON.stringify(payload));return payload;
    },
    acknowledge(id){if(this.read()?.id===id)storage.removeItem(key);},
  };
}
