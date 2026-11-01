// Concrete execution failures remain operational incidents, even if an agent
// accidentally labels them as product questions. Do not infer product choices.
export function questionCategory(question) {
  const evidence=`${question.prompt||''}\n${question.context||''}`;
  if(/Win32|nativeErrorCode|EACCES|EPERM|exec_command.*(?:error|ошиб|отказ)|sandbox|песочниц|хостов(?:ого|ый) исполнител|артефакт[\s\S]{0,40}прогон|runtime-инструмент|codex login/i.test(evidence))return 'technical';
  return ['product','technical','credential'].includes(question.category)?question.category:'product';
}
