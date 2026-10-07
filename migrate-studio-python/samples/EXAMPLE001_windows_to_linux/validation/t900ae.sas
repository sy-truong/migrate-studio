/* Synthetic fixture */
%let task=EXAMPLE001;
%include "&targetStudy.\Programs\Macros\autoexec.sas";
%util_getdata(adae adsl, where=%str(saffl='Y'));
proc import datafile="//placeholder/clinicalstudies/projects/&client/&project/&study/final/rawdata/&prior_therapy..xlsx"
  out=prior dbms=xlsx replace;
run;
