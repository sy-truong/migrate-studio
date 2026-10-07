/* Synthetic ADaM program */
%include "/placeholder/linux/projects/EXAMPLE002/dev/programs/adam/autoexec.sas";
%setupanl;
proc sort data=padam.adae out=adae;
  by usubjid aeseq;
run;
