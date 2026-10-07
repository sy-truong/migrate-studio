/* Synthetic direct XPT export fixture */
%include "../../../../programs/sdtm/20260131_SYNTH/primary/autoexec.sas";
%setupanl;
%let tlfkey=adpr;
libname trans xport "../../../../data/adam/20260131_SYNTH/primary/&tlfkey..xpt";
proc copy in=PADAM out=trans;
run;
