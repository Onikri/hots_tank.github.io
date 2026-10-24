import React,{useState} from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import Icon from './Icons.jsx';
import CatalogBrowser from './CatalogBrowser.jsx';
import ImportSelection from './ImportSelection.jsx';
import {ImportSettings,ImportQueue,ReleaseCalendar} from './ImportParts.jsx';

export default function ServerImport({state,service,onConnect}){
  const [tab,setTab]=useState('catalog'),[items,setItems]=useState([]);
  const submitted=()=>setTab('queue');
  return <><div className="page-title-row"><div><p className="eyebrow">Твоя следующая история</p><h1 className="page-title">Каталог и импорт</h1><p className="page-subtitle">Найди. Выбери. Добавь в свой мир.</p></div><span className="import-cloud-icon"><Icon name="cloud" size={28}/></span></div>
    <ImportSettings service={service} state={state} onConnect={onConnect}/>
    <Tabs.Root value={tab} onValueChange={setTab}><Tabs.List className="import-tabs catalog-main-tabs" aria-label="Каталог и импорт"><Tabs.Trigger value="catalog">Каталог</Tabs.Trigger><Tabs.Trigger value="calendar">Календарь</Tabs.Trigger><Tabs.Trigger value="queue">Загрузки{service.active&&<i className="tab-live-dot"/>}</Tabs.Trigger><Tabs.Trigger value="link">По ссылке</Tabs.Trigger></Tabs.List>
      <Tabs.Content value="catalog"><CatalogBrowser state={state} service={service} onSubmitted={submitted} onItems={setItems}/></Tabs.Content>
      <Tabs.Content value="calendar"><ReleaseCalendar items={items}/></Tabs.Content>
      <Tabs.Content value="queue"><ImportQueue service={service}/></Tabs.Content>
      <Tabs.Content value="link"><section className="settings-card"><h2 className="section-title">Добавить по ссылке</h2><p className="page-subtitle">Публичная страница с плеером, MP4/HLS-ссылка или глава для чтения.</p><ImportSelection state={state} service={service} manual onSubmitted={submitted}/></section></Tabs.Content>
    </Tabs.Root>
  </>;
}
