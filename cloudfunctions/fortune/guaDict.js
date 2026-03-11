'use strict';

const GUA_DICT = {
  "11": { name: "乾为天", meaning: "大通，利于正道", advice: "刚健中正，见龙在田" },
  "88": { name: "坤为地", meaning: "柔顺厚德，包容万物", advice: "宜守不宜进，厚德载物" },
  "66": { name: "坎为水", meaning: "重重险阻，心中常忧", advice: "常思忧患，以诚破险" },
  "33": { name: "离为火", meaning: "明察秋毫，文明光辉", advice: "保持清明，切忌虚荣" },
  "77": { name: "艮为山", meaning: "停止不前，适可而止", advice: "行止有节，动静不失其时" },
  "55": { name: "巽为风", meaning: "谦逊顺从，随风潜入", advice: "顺应趋势，利见贵人" },
  "44": { name: "震为雷", meaning: "震惊百里，声势浩大", advice: "戒慎恐惧，反省自身" },
  "22": { name: "兑为泽", meaning: "喜悦交流，和睦相处", advice: "和悦处事，谨防言语是非" },
  "18": { name: "天地否", meaning: "闭塞不通，上下不和", advice: "收敛锋芒，隐忍待发" },
  "81": { name: "地天泰", meaning: "天地交泰，万物通达", advice: "把握良机，乘势而上" },
  "63": { name: "水火既济", meaning: "功德圆满，初吉终乱", advice: "居安思危，防微杜渐" },
  "36": { name: "火水未济", meaning: "事未竟成，充满希望", advice: "坚持到底，黎明前的黑暗" },
  "12": { name: "天泽履", meaning: "如履薄冰，礼仪规范", advice: "谨言慎行，以礼待人" },
  "21": { name: "泽天夬", meaning: "决断清除，破旧立新", advice: "果断行动，但不宜过刚" }
};

function getGuaInfo(upper, lower) {
  const key = `${upper}${lower}`;
  return GUA_DICT[key] || { name: "未知卦", meaning: "解析中", advice: "静心待之" };
}

module.exports = { GUA_DICT, getGuaInfo };
