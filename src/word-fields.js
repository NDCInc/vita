import {emptyDraft, readDraft, SECTIONS} from './draft.js';

// Bookmarks contain only the words shown in Word. A document edited outside
// those ranges falls back to the normal importer so new paragraphs survive.
export function readWordFields(root) {
  const ns = root.namespaceURI, draft = emptyDraft(), entries = new Map();
  const fieldNames = new Set(['name','email','phone','location','website','summary']);
  const itemFields = new Set(['title','organization','dates','details']);
  // For tracked changes, the regular Word reader applies revision rules.
  if (['del','moveFrom','drawing','object'].some(type=>root.getElementsByTagNameNS(ns,type).length)) return null;
  const used = new Set();
  let tagged = 0;
  for (const paragraph of root.getElementsByTagNameNS(ns,'p')) {
    const active = new Map(), pieces = [];
    let loose = '';
    const walker = root.ownerDocument.createTreeWalker(paragraph,NodeFilter.SHOW_ELEMENT,{
      acceptNode:node=>node.namespaceURI===ns && ['del','moveFrom','p'].includes(node.localName)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) {
      const node=walker.currentNode;
      if (node.namespaceURI!==ns) continue;
      if (node.localName==='bookmarkStart') {
        const name=node.getAttributeNS(ns,'name') || '';
        if (!name.startsWith('Vita1_')) continue;
        if (used.has(name) || active.size) return null;
        used.add(name);
        const part={name,text:''}; pieces.push(part);
        active.set(node.getAttributeNS(ns,'id'),part);
      } else if (node.localName==='bookmarkEnd') active.delete(node.getAttributeNS(ns,'id'));
      else if (['t','tab','br','cr','noBreakHyphen'].includes(node.localName)) {
        const text=node.localName==='t'?node.textContent:node.localName==='tab'?' ':node.localName==='noBreakHyphen'?'‑':'\n';
        const part=active.values().next().value;
        if (part) part.text+=text;
        else loose+=text;
      }
    }
    if (active.size || /[^\s•|—]/u.test(loose) || (!pieces.length && loose.trim())) return null;
    for (const {name,text} of pieces) {
      const [,scope,field,serial] = name.split('_');
      if (!/^\d+$/u.test(serial || '')) return null;
      if (scope==='header' && fieldNames.has(field)) {
        if (draft[field]) return null;
        draft[field]=text; tagged++;
      } else if (scope==='label') {
        if (text!==(field==='Additional'?'Additional Information':field) || (field!=='Summary' && !SECTIONS.includes(field))) return null;
      } else if (/^e\d+[A-Za-z]+$/u.test(scope) && itemFields.has(field)) {
        const section=scope.replace(/^e\d+/u,'');
        if (!SECTIONS.includes(section)) return null;
        if (!entries.has(scope)) entries.set(scope,{section,title:'',organization:'',dates:'',details:'',page:1});
        const item=entries.get(scope);
        if (item[field] && field!=='details') return null;
        item[field]+=(item[field]?'\n':'')+text; tagged++;
      } else return null;
    }
  }
  if (!tagged) return null;
  draft.entries=[...entries.values()];
  try { return readDraft(draft); } catch { return null; }
}
