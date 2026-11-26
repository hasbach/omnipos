export default {
  en: {
    df_title: 'Forecast', df_description: 'Eight rolling one-week forecasts. WAPE is total absolute error divided by actual units; lower is better. Days without sales count as zero. Unavailable means no scored demand.',
    df_refresh: 'Refresh', df_loading: 'Loading forecast accuracy…', df_error: 'Could not load or save forecast settings.', df_unavailable: 'Unavailable',
    df_class: 'ABC class', df_wape: 'WAPE', df_product: 'Product', df_days: 'Scored days', df_config: 'Salary days and holiday / Ramadan periods',
    df_config_help: 'Enter JSON: salaryDays is a list of days of the month; periods is a list of {from, to, multiplier}, using YYYY-MM-DD dates. End dates are inclusive; overlapping multipliers multiply. Changes apply to the next pipeline run.', df_save: 'Save settings',
  },
  ar: {
    df_title: 'التوقعات', df_description: 'ثمانية توقعات أسبوعية متتالية. الخطأ هو مجموع الفروق المطلقة مقسوماً على الوحدات الفعلية؛ الأقل أفضل. الأيام دون مبيعات تساوي صفراً. غير متاح يعني عدم وجود طلب مقيم.',
    df_refresh: 'تحديث', df_loading: 'جار تحميل دقة التوقعات…', df_error: 'تعذر تحميل أو حفظ إعدادات التوقعات.', df_unavailable: 'غير متاح',
    df_class: 'فئة ABC', df_wape: 'نسبة الخطأ المرجح', df_product: 'المنتج', df_days: 'الأيام المقيمة', df_config: 'أيام الرواتب وفترات العطل ورمضان',
    df_config_help: 'أدخل JSON: salaryDays قائمة بأيام الشهر؛ periods قائمة من {from, to, multiplier} بتواريخ YYYY-MM-DD. تاريخ النهاية مشمول وتضرب المعاملات المتداخلة. تطبق التغييرات عند التشغيل التالي.', df_save: 'حفظ الإعدادات',
  },
  fr: {
    df_title: 'Prévisions', df_description: 'Huit prévisions hebdomadaires glissantes. WAPE : erreur absolue totale divisée par les unités réelles ; plus faible est meilleur. Les jours sans ventes comptent pour zéro. Indisponible signifie aucune demande évaluée.',
    df_refresh: 'Actualiser', df_loading: 'Chargement de la précision…', df_error: 'Impossible de charger ou enregistrer les paramètres.', df_unavailable: 'Indisponible',
    df_class: 'Classe ABC', df_wape: 'WAPE', df_product: 'Produit', df_days: 'Jours évalués', df_config: 'Jours de paie et périodes de fêtes / Ramadan',
    df_config_help: 'Saisir du JSON : salaryDays contient les jours du mois ; periods contient {from, to, multiplier}, avec des dates YYYY-MM-DD. Les dates de fin sont incluses ; les coefficients superposés se multiplient. Application au prochain calcul.', df_save: 'Enregistrer',
  },
};
