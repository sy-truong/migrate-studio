/* Synthetic lab import fixture */
%let task=EXAMPLE001;
%include "&targetStudy.\Programs\Macros\autoexec.sas";
proc import datafile="//placeholder/clinicalstudies/projects/&client/&project/&study/final/rawdata/&dev_ext_dataset."
  out=check_lb dbms=XLSX replace;
run;
