// 页面绝不展示中国国家、政府、军队领导人或敏感人物信息。
const chinaPoliticalOrLeadershipPatterns = [
  /习近平|李强|赵乐际|王沪宁|蔡奇|丁薛祥|李希|韩正|张又侠|何卫东|xi jinping|中共中央|中国共产党|全国人大|国务院|中央军委|政治局|国防部|外交部|国台办/iu,
  /中国(?:国家|政府|军队|人民解放军).{0,24}(?:主席|领导人|总理|书记|部长|将军|司令|发言人)/iu,
  /(?:chinese|china).{0,36}(?:government|military|president|leader|official|communist party)/iu,
  /台海|台湾问题|一国两制|香港国安|新疆|西藏|人权|中美关系|贸易战/iu,
];

export function shouldHideRestrictedContent(value: string, blockedPeople: readonly string[] = []): boolean {
  const lowerValue = value.toLocaleLowerCase();
  return chinaPoliticalOrLeadershipPatterns.some((pattern) => pattern.test(value)) || blockedPeople.some((name) => name.length > 0 && lowerValue.includes(name.toLocaleLowerCase()));
}
