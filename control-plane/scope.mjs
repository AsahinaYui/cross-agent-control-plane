function globRegex(glob) {
  let pattern="^";
  for(let i=0;i<glob.length;i+=1) {
    const char=glob[i];
    if(char==="*"&&glob[i+1]==="*"&&glob[i+2]==="/") { pattern+="(?:.*/)?";i+=2; }
    else if(char==="*"&&glob[i+1]==="*") { pattern+=".*";i+=1; }
    else if(char==="*") pattern+="[^/]*";
    else if(char==="?") pattern+="[^/]";
    else pattern+=char.replace(/[|\\{}()[\]^$+?.]/g,"\\$&");
  }
  return new RegExp(`${pattern}$`);
}
const matches=(path,patterns)=>patterns.some((pattern)=>globRegex(pattern.replaceAll("\\","/")).test(path.replaceAll("\\","/")));
export function evaluateScope(scope,changedFiles) {
  const allow=scope.allow?.length?scope.allow:["**/*"],deny=scope.deny??[];
  const violations=changedFiles.filter((path)=>!matches(path,allow)||matches(path,deny));
  return {status:violations.length?"failed":"passed",changed_files:changedFiles,violations};
}
